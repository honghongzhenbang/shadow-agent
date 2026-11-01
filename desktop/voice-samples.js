(() => {
  const $ = id => document.getElementById(id), api = window.shadowVoice, dialog = $('samplesDialog');
  let page = 1, pagination, generation = 0, loading = false, writing = false, pending;
  let audio, playing, audioGeneration = 0, audioLoading = false;
  const text = (tag, value, className) => {
    const node = document.createElement(tag); node.textContent = value;
    if (className) node.className = className;
    return node;
  };
  const icon = name => { const node = document.createElement('i'); node.dataset.lucide = name; return node; };
  const icons = () => window.lucide?.createIcons();
  const button = (name, label, handler) => {
    const node = text('button', '', 'icon'); node.type = 'button'; node.title = label;
    node.setAttribute('aria-label', label); node.append(icon(name)); node.addEventListener('click', handler); return node;
  };
  const ref = sample => ({ sampleId: sample.id, revisionToken: sample.revisionToken });
  const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '时间未记录';
  const message = (value, error = false) => { $('samplesMessage').textContent = value; $('samplesMessage').className = error ? 'error' : ''; };
  const errorMessage = error => error.message.includes('声纹样本已变更')
    ? '声纹样本已变更，本次未修改。请重新选择。' : error.message;
  const time = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  function controls() {
    for (const el of dialog.querySelectorAll('button,input,select')) el.disabled = writing || loading;
    $('closeSamples').disabled = writing;
    $('previousSamples').disabled = writing || loading || !pagination?.hasPrevious;
    $('nextSamples').disabled = writing || loading || !pagination?.hasNext;
    $('sampleSeek').disabled = writing || loading || audioLoading || !playing?.chunk;
    $('toggleSampleAudio').disabled = writing || loading || audioLoading || !audio;
  }
  function stop() {
    audioGeneration++; audio?.pause(); audio = null; playing = null; audioLoading = false;
    $('samplePlayer').hidden = true; controls();
  }
  function renderPlayer() {
    if (!playing) return;
    const { chunk } = playing, paused = !audio || audio.paused;
    $('samplePlayer').hidden = false;
    $('sampleSeek').max = chunk.durationMs / 1000;
    $('sampleSeek').value = Math.min(chunk.durationMs, chunk.offsetMs + (audio?.currentTime || 0) * 1000) / 1000;
    $('sampleTime').textContent = `${time(Number($('sampleSeek').value) * 1000)} / ${time(chunk.durationMs)}`;
    $('toggleSampleAudio').replaceChildren(icon(paused ? 'play' : 'pause'));
    const label = paused ? '继续来源录音' : '暂停来源录音';
    $('toggleSampleAudio').title = label; $('toggleSampleAudio').setAttribute('aria-label', label); icons();
  }
  async function play(sample, offsetMs = 0, autoplay = true) {
    stop(); const current = ++audioGeneration; audioLoading = true; controls();
    try {
      const chunk = await api.sampleAudio({ ...ref(sample), offsetMs });
      if (current !== audioGeneration || !dialog.open) return;
      if (!chunk.dataUrl) throw new Error('来源音频暂不可用；样本仍可单独移除。');
      playing = { sample, chunk }; audio = new Audio(chunk.dataUrl);
      $('samplePlaybackTitle').textContent = `来源录音 · ${sample.title} · ${date(sample.recordedAt)}`;
      audio.ontimeupdate = () => { if (current === audioGeneration) renderPlayer(); };
      audio.onended = () => {
        if (current !== audioGeneration) return;
        if (chunk.nextOffsetMs !== null) void play(sample, chunk.nextOffsetMs);
        else renderPlayer();
      };
      audio.onerror = () => { if (current === audioGeneration) { stop(); message('来源音频播放失败，原文件未修改。', true); } };
      if (autoplay) await audio.play();
      if (current === audioGeneration) renderPlayer();
    } catch (e) { if (current === audioGeneration) { stop(); message(e.message, true); } }
    finally { if (current === audioGeneration) { audioLoading = false; controls(); } }
  }
  function cancelRemoval() { pending = null; $('removeSamplePrompt').hidden = true; }
  async function load() {
    const current = ++generation; loading = true; cancelRemoval(); stop(); controls();
    try {
      const result = await api.samples({ page, pageSize: 10, personId: $('samplePerson').value || undefined,
        query: $('sampleQuery').value, status: $('sampleStatusFilter').value });
      if (current !== generation || !dialog.open) return;
      pagination = result.pagination; page = pagination.page;
      $('samplePageLabel').textContent = `${page} / ${Math.max(1, pagination.totalPages)} · ${pagination.total} 个样本`;
      $('sampleList').replaceChildren(...result.samples.map(sample => {
        const row = text('article', '', 'sample-row'); row.dataset.sampleId = sample.id;
        const body = text('div', '');
        body.append(text('strong', sample.name || '未命名人物'), text('span',
          ({ current: '当前声音组', historical: '旧声音组', unavailable: '来源未就绪' })[sample.sourceVersion], 'sample-version'),
        text('p', `${sample.title} · ${date(sample.recordedAt)}`),
        text('p', `${sample.active ? '已启用' : '已停用'} · 保存于 ${date(sample.created_at)}`),
        text('p', `录音 ${sample.recording_id} · ${sample.speaker_label}`));
        const actions = text('div', '', 'header-actions');
        actions.append(button('play', '听来源录音', () => play(sample)), button('trash-2', '移除此样本', () => {
          pending = sample; $('removeSampleTitle').textContent = `移除“${sample.name || '未命名人物'}”的这一条声纹？`;
          $('removeSamplePrompt').hidden = false; $('confirmRemoveSample').focus();
        }));
        row.append(body, actions); return row;
      }));
      if (!result.samples.length) $('sampleList').append(text('p', '暂无匹配的声纹样本', 'empty'));
      icons();
    } catch (e) {
      if (current === generation) { pagination = null; $('sampleList').replaceChildren(); $('samplePageLabel').textContent = '读取失败'; message(e.message, true); }
    } finally { if (current === generation) { loading = false; controls(); } }
  }
  function open(personId = '') {
    if (dialog.open) return;
    const people = Array.from($('people').querySelectorAll('[data-person-id]'));
    if (personId && !people.some(row => row.dataset.personId === personId)) return;
    $('samplePerson').replaceChildren(new Option('全部人物', ''),
      ...people.map(row => new Option(row.dataset.personName, row.dataset.personId)));
    $('samplePerson').value = personId;
    $('sampleQuery').value = ''; $('sampleStatusFilter').value = 'all';
    page = 1; message(''); dialog.showModal();
    document.dispatchEvent(new Event('voice-samples-opened'));
    void load(); $('sampleQuery').focus();
  }
  $('manageSamples').addEventListener('click', () => open());
  $('people').addEventListener('click', event => {
    const row = event.target.closest('button[data-person-id]');
    if (row && !row.disabled) open(row.dataset.personId);
  });
  $('closeSamples').addEventListener('click', () => { if (!writing) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (writing) event.preventDefault(); });
  dialog.addEventListener('close', () => { generation++; loading = false; cancelRemoval(); stop(); });
  $('sampleSearch').addEventListener('submit', event => { event.preventDefault(); page = 1; message(''); void load(); });
  $('sampleStatusFilter').addEventListener('change', () => { page = 1; message(''); void load(); });
  $('samplePerson').addEventListener('change', () => { page = 1; message(''); void load(); });
  $('reloadSamples').addEventListener('click', () => { message(''); void load(); });
  for (const [id, delta] of [['previousSamples', -1], ['nextSamples', 1]]) $(id).addEventListener('click', () => { page += delta; void load(); });
  $('cancelRemoveSample').addEventListener('click', cancelRemoval);
  $('confirmRemoveSample').addEventListener('click', async () => {
    if (writing || !pending) return;
    const sample = pending; writing = true; controls(); stop();
    try {
      const result = await api.forgetSample(ref(sample));
      message(result.removed ? '已移除此样本；音频与历史标注保留。' : '此样本已被移除，没有重复修改。');
      document.dispatchEvent(new Event('voice-samples-changed')); await load();
    } catch (e) { await load(); message(errorMessage(e), true); }
    finally { writing = false; controls(); }
  });
  $('toggleSampleAudio').addEventListener('click', async () => {
    if (!audio || !playing) return;
    if (audio.ended) { void play(playing.sample); return; }
    if (!audio.paused) audio.pause();
    else { try { await audio.play(); } catch (e) { message(e.message, true); } }
    renderPlayer();
  });
  $('sampleSeek').addEventListener('change', () => {
    if (!playing) return;
    const offset = Math.min(Number($('sampleSeek').value) * 1000, Math.max(0, playing.chunk.durationMs - 1));
    void play(playing.sample, offset, Boolean(audio && !audio.paused));
  });
})();
