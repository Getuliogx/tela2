(() => {
  "use strict";
  const LOCAL_KEY = "tela2-painel-salvos-v1";
  const PASSWORD_KEY = "tela2-admin-password";
  const $ = selector => document.querySelector(selector);
  const resultsEl = $("#results");
  const savedEl = $("#saved");
  const currentEl = $("#current");
  const noticeEl = $("#notice");
  const passwordEl = $("#adminPassword");
  const clearOverlayButton = $("#clearOverlay");
  const episodeControlsEl = $("#episodeControls");
  const episodeEl = $("#episode");
  const seasonEl = $("#season");
  const episodeAutoStatusEl = $("#episodeAutoStatus");
  const upnextQueueEl = $("#upnextQueue");
  const upnextCountEl = $("#upnextCount");
  const upnextLabelEl = $("#upnextLabel");
  const upnextIntervalEl = $("#upnextInterval");
  const upnextDurationEl = $("#upnextDuration");
  const upnextEnabledEl = $("#upnextEnabled");
  const saveUpnextButton = $("#saveUpnext");
  const testUpnextButton = $("#testUpnext");
  const upnextRuntimeStatusEl = $("#upnextRuntimeStatus");
  const themeModeEl = $("#themeMode");
  const themeNameEl = $("#themeName");
  const themeSceneEl = $("#themeScene");
  const themeMotifEl = $("#themeMotif");
  const themeAccentEl = $("#themeAccent");
  const themeAccent2El = $("#themeAccent2");
  const themeSaveForItemEl = $("#themeSaveForItem");
  const themePreviewEl = $("#themePreview");
  const themeTargetInfoEl = $("#themeTargetInfo");
  const themeSuggestButton = $("#themeSuggest");
  const themeApplyButton = $("#themeApply");
  const themeResetButton = $("#themeReset");

  let saved = loadLocal();
  let upnext = null;
  let currentOverlayItem = null;
  let episodeTimer = null;
  let episodeRequestSequence = 0;
  let syncingEpisodeControls = false;

  passwordEl.value = localStorage.getItem(PASSWORD_KEY) || "";
  passwordEl.addEventListener("input", () => localStorage.setItem(PASSWORD_KEY, passwordEl.value));

  function keyOf(item){return item.type + ":" + item.tmdbId}
  function escapeHtml(value){return String(value||"").replace(/[&<>\"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"})[ch])}
  function loadLocal(){try{const value=JSON.parse(localStorage.getItem(LOCAL_KEY)||"[]");return Array.isArray(value)?value:[]}catch{return []}}
  function saveLocal(){localStorage.setItem(LOCAL_KEY,JSON.stringify(saved))}

  function normalizeTheme(theme={}){
    const safeColor=value=>/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(value||"").trim())?String(value).trim():"#a855f7";
    return {
      mode:["auto","manual","off"].includes(String(theme.mode||""))?String(theme.mode):"manual",
      name:String(theme.name||"").trim().slice(0,60),
      scene:String(theme.scene||"").trim().slice(0,220),
      motif:String(theme.motif||"").trim().slice(0,80),
      accent:safeColor(theme.accent||"#a855f7"),
      accent2:/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(theme.accent2||"").trim())?String(theme.accent2).trim():"#7c3aed"
    }
  }

  function themeFromItem(item){
    return normalizeTheme(item?.themeConfig||{})
  }

  function defaultThemePreview(){
    fillThemeForm({mode:"manual",name:"",scene:"",motif:"",accent:"#a855f7",accent2:"#7c3aed"})
    themeTargetInfoEl.textContent="Selecione ou envie um conteúdo para editar o fundo."
  }

  function themeFormValue(){
    return normalizeTheme({
      mode:themeModeEl.value,
      name:themeNameEl.value,
      scene:themeSceneEl.value,
      motif:themeMotifEl.value,
      accent:themeAccentEl.value,
      accent2:themeAccent2El.value
    })
  }

  function renderThemePreview(theme){
    const safe=normalizeTheme(theme);
    themePreviewEl.style.setProperty("--theme-a",safe.accent);
    themePreviewEl.style.setProperty("--theme-b",safe.accent2);
    const title=safe.name||(
      safe.mode==="auto"?"Tema automático":safe.mode==="off"?"Fundo desativado":"Tema manual"
    );
    const scene=safe.scene||"Sem descrição ainda.";
    const motif=safe.motif?`<div class="theme-chip">${escapeHtml(safe.motif)}</div>`:`<div class="theme-chip">Prévia do fundo</div>`;
    themePreviewEl.innerHTML=`${motif}<h3>${escapeHtml(title)}</h3><p>${escapeHtml(scene)}</p>`
  }

  function fillThemeForm(theme,item=null){
    const safe=normalizeTheme(theme||{});
    themeModeEl.value=safe.mode;
    themeNameEl.value=safe.name;
    themeSceneEl.value=safe.scene;
    themeMotifEl.value=safe.motif;
    themeAccentEl.value=safe.accent;
    themeAccent2El.value=safe.accent2;
    renderThemePreview(safe);
    themeTargetInfoEl.textContent=item
      ? `Editando fundo de: ${item.displayTitle||item.title}`
      : "Selecione ou envie um conteúdo para editar o fundo.";
  }

  async function requestThemeSuggestion(){
    if(!currentOverlayItem){notify("Selecione um conteúdo primeiro",true);return}
    themeSuggestButton.disabled=true;
    try{
      const payload=await api("/api/theme/suggest",{method:"POST",body:JSON.stringify({item:currentOverlayItem})});
      fillThemeForm({...payload.theme,mode:"manual"},currentOverlayItem);
      notify("Sugestão carregada")
    }catch(error){notify(error.message,true)}finally{themeSuggestButton.disabled=false}
  }

  async function applyTheme(reset=false){
    if(!currentOverlayItem){notify("Selecione um conteúdo primeiro",true);return}
    themeApplyButton.disabled=true;themeResetButton.disabled=true;
    try{
      const theme=reset?{mode:"auto"}:themeFormValue();
      const payload=await api("/api/theme/apply",{
        method:"POST",
        body:JSON.stringify({
          item:currentOverlayItem,
          themeConfig:theme,
          mode:reset?"auto":theme.mode,
          reset,
          saveForItem:themeSaveForItemEl.checked
        })
      });
      if(Array.isArray(payload.items))mergeSaved(payload.items);
      renderCurrent(payload.state||currentOverlayItem);
      fillThemeForm((payload.state||payload.item)?.themeConfig||theme,currentOverlayItem);
      notify(reset?"Tema automático restaurado":"Fundo personalizado aplicado")
    }catch(error){notify(error.message,true)}finally{themeApplyButton.disabled=false;themeResetButton.disabled=false}
  }

  function mergeSaved(items){const map=new Map();for(const item of [...saved,...items]){if(item&&item.tmdbId)map.set(keyOf(item),item)}saved=[...map.values()];saveLocal();renderSaved()}
  function headers(){return {"Content-Type":"application/json","X-Admin-Password":passwordEl.value}}
  function notify(message,error=false){noticeEl.textContent=message;noticeEl.className="notice show"+(error?" error":"");clearTimeout(notify.timer);notify.timer=setTimeout(()=>noticeEl.className="notice",2800)}
  async function api(url,options={}){const response=await fetch(url,{cache:"no-store",...options,headers:{...headers(),...(options.headers||{})}});let payload=null;try{payload=await response.json()}catch{}if(!response.ok)throw new Error(payload?.error||("Erro "+response.status));return payload}
  function posterHtml(item){const title=escapeHtml(item.title||"Sem capa");const image=item.poster?`<img src="${escapeHtml(item.poster)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`:"";const fallbackStyle=item.poster?"display:none":"";return `<div class="poster-frame">${image}<div class="poster-fallback" style="${fallbackStyle}">${title}</div></div>`}
  function seriesControlsHtml(item,savedMode){
    if(!savedMode||item.type!=="tv")return "";

    const seasons=Array.isArray(item.seasons)&&item.seasons.length
      ? item.seasons
      : [{
          seasonNumber:Number(item.savedSeason||item.selectedSeason||1),
          name:`Temporada ${Number(item.savedSeason||item.selectedSeason||1)}`,
          episodeCount:Number(item.episodeCount||item.savedEpisode||1),
          poster:item.poster||""
        }];

    const selectedSeason=Number(
      item.savedSeason||
      item.selectedSeason||
      seasons[0].seasonNumber||
      1
    );

    const selectedMeta=seasons.find(season=>
      Number(season.seasonNumber)===selectedSeason
    )||seasons[0];

    const episodeCount=Math.max(
      1,
      Number(
        selectedMeta?.episodeCount||
        item.episodeCount||
        item.savedEpisode||
        1
      )
    );

    const selectedEpisode=Math.max(
      1,
      Math.min(
        Number(item.savedEpisode||item.selectedEpisode||1),
        episodeCount
      )
    );

    const options=seasons.map(season=>{
      const number=Number(season.seasonNumber);
      const name=String(season.name||`Temporada ${number}`);
      return `<option value="${number}" ${number===selectedSeason?"selected":""}>${escapeHtml(name)}</option>`
    }).join("");

    return `<div class="series-card-controls" data-series-controls data-key="${escapeHtml(keyOf(item))}">
      <label class="series-card-control">
        <span>Temporada</span>
        <select class="series-card-select" data-series-season>
          ${options}
        </select>
      </label>

      <label class="series-card-control">
        <span>Episódio</span>
        <div class="series-card-stepper">
          <button type="button" class="series-card-step" data-action="series-episode-down" data-key="${escapeHtml(keyOf(item))}">▼</button>
          <input class="series-card-episode" data-series-episode type="number" min="1" max="${episodeCount}" step="1" value="${selectedEpisode}">
          <button type="button" class="series-card-step" data-action="series-episode-up" data-key="${escapeHtml(keyOf(item))}">▲</button>
        </div>
      </label>

      <label class="series-card-display">
        <input type="checkbox" data-series-show-season ${item.showSeason===false?"":"checked"}>
        <span>Mostrar T no título da overlay</span>
      </label>

      <div class="series-card-status" data-series-status>
        ${item.showSeason===false
          ? `EP${selectedEpisode} • temporada ${selectedSeason} selecionada • ${episodeCount} episódios`
          : `EP${selectedEpisode} - T${selectedSeason} • ${episodeCount} episódios`}
      </div>
    </div>`
  }

  function cardHtml(item,savedMode=false){
    const progress=item.savedSuffix
      ? ` • ${escapeHtml(
          item.type==="tv" &&
          item.showSeason===false &&
          item.savedEpisode
            ? `EP${item.savedEpisode}`
            : item.savedSuffix
        )}`
      : "";

    return `<article class="card" data-card-key="${escapeHtml(keyOf(item))}">
      ${posterHtml(item)}
      <div class="card-body">
        <div class="card-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
        <div class="card-meta">${escapeHtml(item.typeLabel||(item.type==="tv"?"Série":"Filme"))}${item.year?" • "+escapeHtml(item.year):""}${progress}</div>
        ${seriesControlsHtml(item,savedMode)}
        <div class="card-actions">
          <button class="primary small" data-action="update" data-key="${escapeHtml(keyOf(item))}">Atualizar overlay</button>
          <button class="secondary small" data-action="upnext-add" data-key="${escapeHtml(keyOf(item))}">Adicionar aos próximos</button>
          ${savedMode
            ? `<button class="danger small" data-action="remove" data-key="${escapeHtml(keyOf(item))}">Excluir</button>`
            : `<button class="secondary small" data-action="save" data-key="${escapeHtml(keyOf(item))}">Salvar</button>`}
        </div>
      </div>
    </article>`
  }
  function upnextDisplayTitle(item){
    if(item.type!=="tv"||!Number(item.savedEpisode||item.selectedEpisode)){
      return item.title
    }

    const episode=Number(item.savedEpisode||item.selectedEpisode);
    const season=Number(item.savedSeason||item.selectedSeason);

    return item.showSeason===false||!season
      ? `${item.title} EP${episode}`
      : `${item.title} EP${episode} - T${season}`
  }

  function formatClock(timestamp){
    const value=Number(timestamp||0);
    if(!value)return "";
    return new Date(value).toLocaleTimeString("pt-BR",{
      hour:"2-digit",
      minute:"2-digit",
      second:"2-digit"
    })
  }

  async function refreshUpnextRuntime(){
    try{
      const response=await fetch(
        "/upnext/current?t="+Date.now(),
        {cache:"no-store"}
      );

      if(!response.ok)return;

      const current=await response.json();

      if(current.active){
        upnextRuntimeStatusEl.textContent=
          `Exibindo agora: ${current.index+1}/${current.total} • termina ${formatClock(current.endsAt)}`
      }else if(current.nextAutomaticAt){
        upnextRuntimeStatusEl.textContent=
          `Próxima exibição automática: ${formatClock(current.nextAutomaticAt)}`
      }else{
        upnextRuntimeStatusEl.textContent=
          current.reason==="empty"
            ?"Adicione pelo menos um próximo conteúdo."
            :"Exibição automática desativada."
      }
    }catch{}
  }

  function renderUpnext(value){
    upnext=value||{
      enabled:true,
      label:"Próximo",
      intervalMinutes:50,
      displaySeconds:10,
      items:[]
    };

    upnextLabelEl.value=upnext.label||"Próximo";
    upnextIntervalEl.value=String(upnext.intervalMinutes||50);
    upnextDurationEl.value=String(upnext.displaySeconds||10);
    upnextEnabledEl.checked=upnext.enabled!==false;

    const items=Array.isArray(upnext.items)?upnext.items:[];
    upnextCountEl.textContent=items.length+" item"+(items.length===1?"":"s");
    testUpnextButton.disabled=items.length===0;

    upnextQueueEl.innerHTML=items.length
      ? items.map(item=>`
          <article class="upnext-item">
            ${item.poster
              ? `<img src="${escapeHtml(item.poster)}" alt="">`
              : `<div class="poster-frame"><div class="poster-fallback">${escapeHtml(item.title)}</div></div>`}
            <div class="upnext-item-copy">
              <div class="upnext-item-title" title="${escapeHtml(upnextDisplayTitle(item))}">${escapeHtml(upnextDisplayTitle(item))}</div>
              <div class="upnext-item-meta">${escapeHtml(item.typeLabel||"")}${item.year?" • "+escapeHtml(item.year):""}</div>
              <button class="danger small upnext-item-remove" data-upnext-remove data-type="${escapeHtml(item.type)}" data-id="${escapeHtml(item.tmdbId)}">Remover</button>
            </div>
          </article>
        `).join("")
      : `<div class="upnext-empty">Nenhum próximo conteúdo adicionado.</div>`
  }

  async function loadUpnext(){
    try{
      const payload=await api("/api/upnext");
      renderUpnext(payload.upnext)
    }catch(error){
      notify(error.message,true)
    }
  }

  async function saveUpnextConfig(){
    const label=upnextLabelEl.value.trim()||"Próximo";
    const intervalMinutes=Math.max(1,Number(upnextIntervalEl.value||50));
    const displaySeconds=Math.max(1,Number(upnextDurationEl.value||10));

    saveUpnextButton.disabled=true;

    try{
      const payload=await api("/api/upnext/config",{
        method:"POST",
        body:JSON.stringify({
          label,
          intervalMinutes,
          displaySeconds,
          enabled:upnextEnabledEl.checked
        })
      });

      renderUpnext(payload.upnext);
      await refreshUpnextRuntime();
      notify("Configuração dos próximos salva")
    }catch(error){
      notify(error.message,true)
    }finally{
      saveUpnextButton.disabled=false
    }
  }

  async function addUpnext(item,source,card){
    let finalItem=item;

    if(source==="saved"&&item.type==="tv"){
      finalItem=await persistSeriesCard(item,card,false)
    }

    const payload=await api("/api/upnext/items",{
      method:"POST",
      body:JSON.stringify({item:finalItem})
    });

    renderUpnext(payload.upnext);
    notify("Adicionado aos próximos: "+upnextDisplayTitle(finalItem))
  }

  function renderResults(items){window.__searchResults=items;resultsEl.innerHTML=items.length?items.map(item=>cardHtml(item,false)).join(""):`<div class="empty">Nenhum resultado encontrado.</div>`}
  function renderSaved(){window.__savedItems=saved;savedEl.innerHTML=saved.length?saved.map(item=>cardHtml(item,true)).join(""):`<div class="empty">Nenhum título salvo.</div>`;$("#savedCount").textContent=saved.length+" salvo"+(saved.length===1?"":"s")}
  function stripEpisodeSuffix(value){
    return String(value||"")
      .replace(/\s+(?:EP|E)\s*0*\d+\s*[-–—]?\s*(?:T|TEMP|TEMPORADA)\s*0*\d+\s*$/i,"")
      .trim()
  }

  function itemFromState(item){
    if(!item)return null;
    return {
      ...item,
      title:item.baseTitle||stripEpisodeSuffix(item.title),
      displayTitle:undefined
    }
  }

  function episodeValuesFromState(item){
    if(!item)return null;

    if(Number(item.episode)>0&&Number(item.season)>0){
      return {
        episode:Number(item.episode),
        season:Number(item.season)
      }
    }

    const text=String(item.displayTitle||item.title||"");
    const match=text.match(/(?:EP|E)\s*0*(\d+)\s*[-–—]?\s*(?:T|TEMP|TEMPORADA)\s*0*(\d+)\s*$/i);

    return match
      ? {episode:Number(match[1]),season:Number(match[2])}
      : null
  }

  function syncEpisodeControls(item){
    currentOverlayItem=itemFromState(item);
    const isSeries=currentOverlayItem&&currentOverlayItem.type==="tv";

    episodeControlsEl.classList.toggle("show",Boolean(isSeries));

    if(!isSeries){
      episodeAutoStatusEl.textContent="Selecione uma série para usar episódio e temporada.";
      episodeAutoStatusEl.className="episode-auto-status";
      return
    }

    const values=episodeValuesFromState(item);

    syncingEpisodeControls=true;
    episodeEl.value=String(values?.episode||1);
    seasonEl.value=String(values?.season||1);
    syncingEpisodeControls=false;

    episodeAutoStatusEl.textContent="Digite ou use as setas. A overlay muda sozinha.";
    episodeAutoStatusEl.className="episode-auto-status"
  }

  function renderCurrent(item){
    clearOverlayButton.disabled=!item;

    if(!item){
      currentEl.innerHTML=`<div class="empty">Nenhum título enviado ainda.</div>`;
      syncEpisodeControls(null);
      defaultThemePreview();
      return
    }

    currentEl.innerHTML=`${posterHtml(item)}<div><div class="title">${escapeHtml(item.displayTitle||item.title)}</div><div class="meta">${escapeHtml(item.typeLabel||"")}${item.year?" • "+escapeHtml(item.year):""}</div></div>`;
    syncEpisodeControls(item);
    fillThemeForm(themeFromItem(item),item)
  }

  function normalizePositiveInteger(input){
    const number=Math.max(1,Math.floor(Number(input.value)||1));
    input.value=String(number);
    return number
  }

  async function updateEpisodeAutomatically(){
    if(syncingEpisodeControls||!currentOverlayItem||currentOverlayItem.type!=="tv")return;

    const episode=normalizePositiveInteger(episodeEl);
    const season=normalizePositiveInteger(seasonEl);
    const requestSequence=++episodeRequestSequence;

    episodeAutoStatusEl.textContent="Atualizando overlay…";
    episodeAutoStatusEl.className="episode-auto-status sending";

    try{
      const payload=await api("/api/overlay",{
        method:"POST",
        body:JSON.stringify({
          item:currentOverlayItem,
          suffix:`EP${episode} - T${season}`
        })
      });

      if(requestSequence!==episodeRequestSequence)return;

      renderCurrent(payload.state);
      episodeAutoStatusEl.textContent=`Atualizado: EP${episode} - T${season}`;
      episodeAutoStatusEl.className="episode-auto-status ok";
      notify(`Overlay atualizada: EP${episode} - T${season}`)
    }catch(error){
      if(requestSequence!==episodeRequestSequence)return;

      episodeAutoStatusEl.textContent=error.message;
      episodeAutoStatusEl.className="episode-auto-status error";
      notify(error.message,true)
    }
  }

  function scheduleEpisodeUpdate(immediate=false){
    if(syncingEpisodeControls)return;

    clearTimeout(episodeTimer);

    if(immediate){
      updateEpisodeAutomatically();
      return
    }

    episodeTimer=setTimeout(updateEpisodeAutomatically,120)
  }

  episodeEl.addEventListener("input",()=>scheduleEpisodeUpdate(false));
  seasonEl.addEventListener("input",()=>scheduleEpisodeUpdate(false));
  episodeEl.addEventListener("change",()=>scheduleEpisodeUpdate(true));
  seasonEl.addEventListener("change",()=>scheduleEpisodeUpdate(true));

  episodeControlsEl.addEventListener("click",event=>{
    const button=event.target.closest("button[data-step-target]");
    if(!button)return;

    const input=button.dataset.stepTarget==="season"?seasonEl:episodeEl;

    if(Number(button.dataset.step)>0){
      input.stepUp()
    }else{
      input.stepDown()
    }

    scheduleEpisodeUpdate(true)
  });

  async function refreshState(){try{const response=await fetch("/state?t="+Date.now(),{cache:"no-store"});renderCurrent(response.ok?await response.json():null);$("#connectionStatus").textContent="Overlay conectada";$("#connectionStatus").className="status ok"}catch{$("#connectionStatus").textContent="Sem conexão";$("#connectionStatus").className="status"}}
  async function loadServerSaved(){try{const payload=await api("/api/saved");mergeSaved(payload.items||[])}catch(error){if(error.message.includes("Senha"))notify(error.message,true)}}
  $("#searchForm").addEventListener("submit",async event=>{event.preventDefault();const form=event.currentTarget;form.classList.add("busy");try{const params=new URLSearchParams({type:$("#type").value,q:$("#query").value.trim(),year:$("#year").value.trim()});const payload=await api("/api/search?"+params);renderResults(payload.results||[])}catch(error){notify(error.message,true)}finally{form.classList.remove("busy")}});
  function replaceSavedItem(updated){
    saved=saved.map(item=>
      keyOf(item)===keyOf(updated)
        ? updated
        : item
    );
    saveLocal()
  }

  function seriesValues(card,item){
    const season=Math.max(
      1,
      Number(
        card?.querySelector("[data-series-season]")?.value||
        item.savedSeason||
        item.selectedSeason||
        1
      )
    );

    const episodeInput=card?.querySelector("[data-series-episode]");
    const max=Math.max(
      1,
      Number(episodeInput?.max||item.episodeCount||1)
    );

    const episode=Math.max(
      1,
      Math.min(
        Number(
          episodeInput?.value||
          item.savedEpisode||
          item.selectedEpisode||
          1
        ),
        max
      )
    );

    if(episodeInput)episodeInput.value=String(episode);

    return {season,episode}
  }

  async function persistSeriesCard(item,card,showNotice=false){
    if(!card||item.type!=="tv")return item;

    const controls=card.querySelector("[data-series-controls]");
    const status=card.querySelector("[data-series-status]");
    const {season,episode}=seriesValues(card,item);

    controls?.classList.add("loading");
    if(status)status.textContent="Carregando capa da temporada…";

    try{
      const payload=await api(
        `/api/saved/tv/${encodeURIComponent(item.tmdbId)}/progress`,
        {
          method:"POST",
          body:JSON.stringify({
            item,
            season,
            episode,
            showSeason:
              card.querySelector("[data-series-show-season]")?.checked !== false
          })
        }
      );

      const updated=payload.item||item;
      replaceSavedItem(updated);
      renderSaved();

      if(showNotice){
        notify(`Salvo: EP${updated.savedEpisode||episode} - T${updated.savedSeason||season}`)
      }

      return updated
    }catch(error){
      if(status)status.textContent=error.message;
      if(showNotice)notify(error.message,true);
      throw error
    }finally{
      controls?.classList.remove("loading")
    }
  }

  async function updateItem(item,source="results",card=null){
    try{
      let finalItem=item;
      let suffix="";

      if(source==="saved"&&item.type==="tv"){
        finalItem=await persistSeriesCard(item,card,false);
        const season=Number(finalItem.savedSeason||finalItem.selectedSeason||1);
        const episode=Number(finalItem.savedEpisode||finalItem.selectedEpisode||1);
        suffix=`EP${episode} - T${season}`
      }

      const payload=await api("/api/overlay",{
        method:"POST",
        body:JSON.stringify({
          item:finalItem,
          suffix,
          season:finalItem.selectedSeason||finalItem.savedSeason,
          episode:finalItem.selectedEpisode||finalItem.savedEpisode
        })
      });

      renderCurrent(payload.state);
      notify("Overlay atualizada: "+payload.state.title)
    }catch(error){
      notify(error.message,true)
    }
  }
  async function addItem(item){saved=[item,...saved.filter(entry=>keyOf(entry)!==keyOf(item))];saveLocal();renderSaved();try{await api("/api/saved",{method:"POST",body:JSON.stringify({item})});notify("Título salvo") }catch(error){notify("Salvo neste navegador. "+error.message,true)}}
  async function removeItem(item){saved=saved.filter(entry=>keyOf(entry)!==keyOf(item));saveLocal();renderSaved();try{await api("/api/saved/"+encodeURIComponent(item.type)+"/"+encodeURIComponent(item.tmdbId),{method:"DELETE"});notify("Título removido")}catch(error){notify("Removido deste navegador. "+error.message,true)}}
  async function handleCards(event,source){
    const button=event.target.closest("button[data-action]");
    if(!button)return;

    const items=source==="saved"
      ? window.__savedItems
      : window.__searchResults;

    const item=(items||[]).find(entry=>
      keyOf(entry)===button.dataset.key
    );

    if(!item)return;

    const card=button.closest(".card");
    const action=button.dataset.action;
    button.disabled=true;

    try{
      if(action==="update"){
        await updateItem(item,source,card)
      }

      if(action==="save"){
        await addItem(item)
      }

      if(action==="remove"){
        await removeItem(item)
      }

      if(action==="upnext-add"){
        await addUpnext(item,source,card)
      }

      if(
        action==="series-episode-up"||
        action==="series-episode-down"
      ){
        const input=card?.querySelector("[data-series-episode]");

        if(input){
          if(action==="series-episode-up"){
            input.stepUp()
          }else{
            input.stepDown()
          }

          await persistSeriesCard(item,card,false)
        }
      }
    }finally{
      if(button.isConnected)button.disabled=false
    }
  }

  resultsEl.addEventListener(
    "click",
    event=>handleCards(event,"results")
  );

  savedEl.addEventListener(
    "click",
    event=>handleCards(event,"saved")
  );

  savedEl.addEventListener("change",async event=>{
    const control=event.target.closest(
      "[data-series-season],[data-series-episode],[data-series-show-season]"
    );

    if(!control)return;

    const card=control.closest(".card");
    const item=(window.__savedItems||[]).find(entry=>
      keyOf(entry)===card?.dataset.cardKey
    );

    if(!item)return;

    try{
      await persistSeriesCard(item,card,false)
    }catch{}
  });
  $("#refreshState").addEventListener("click",refreshState);
  themeModeEl.addEventListener("change",()=>renderThemePreview(themeFormValue()));
  themeNameEl.addEventListener("input",()=>renderThemePreview(themeFormValue()));
  themeSceneEl.addEventListener("input",()=>renderThemePreview(themeFormValue()));
  themeMotifEl.addEventListener("input",()=>renderThemePreview(themeFormValue()));
  themeAccentEl.addEventListener("input",()=>renderThemePreview(themeFormValue()));
  themeAccent2El.addEventListener("input",()=>renderThemePreview(themeFormValue()));
  themeSuggestButton.addEventListener("click",requestThemeSuggestion);
  themeApplyButton.addEventListener("click",()=>applyTheme(false));
  themeResetButton.addEventListener("click",()=>applyTheme(true));

  saveUpnextButton.addEventListener("click",saveUpnextConfig);

  testUpnextButton.addEventListener("click",async()=>{
    if(!Array.isArray(upnext?.items)||!upnext.items.length){
      upnextRuntimeStatusEl.textContent="Adicione pelo menos um próximo conteúdo.";
      return
    }

    testUpnextButton.disabled=true;

    try{
      const payload=await api("/api/upnext/trigger",{
        method:"POST"
      });

      renderUpnext(payload.upnext);
      await refreshUpnextRuntime();
      notify("Mostrando próximos conteúdos agora")
    }catch(error){
      notify(error.message,true)
    }finally{
      testUpnextButton.disabled=
        !Array.isArray(upnext?.items)||
        upnext.items.length===0
    }
  });

  upnextQueueEl.addEventListener("click",async event=>{
    const button=event.target.closest("[data-upnext-remove]");
    if(!button)return;

    button.disabled=true;

    try{
      const payload=await api(
        `/api/upnext/items/${encodeURIComponent(button.dataset.type)}/${encodeURIComponent(button.dataset.id)}`,
        {method:"DELETE"}
      );

      renderUpnext(payload.upnext);
      notify("Próximo conteúdo removido")
    }catch(error){
      button.disabled=false;
      notify(error.message,true)
    }
  });

  clearOverlayButton.addEventListener("click",async()=>{
    if(clearOverlayButton.disabled)return;

    clearTimeout(episodeTimer);
    episodeRequestSequence+=1;
    clearOverlayButton.disabled=true;

    try{
      await api("/api/overlay",{method:"DELETE"});
      renderCurrent(null);
      notify("Conteúdo removido da overlay")
    }catch(error){
      clearOverlayButton.disabled=false;
      notify(error.message,true)
    }
  });

  renderSaved();refreshState();loadServerSaved();loadUpnext();refreshUpnextRuntime();setInterval(refreshState,5000);setInterval(refreshUpnextRuntime,2000);
})();
