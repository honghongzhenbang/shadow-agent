(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.shadowVoice;
  const views = ['recommended', 'people', 'recordings'];
  const reasons = {
    task_related: '关联任务', identity_conflict: '标注冲突', ambiguous_match: '人物候选接近',
    coverage: '多份录音', voice_sample: '可登记声音样本', insufficient_audio: '声音较短',
  };
  const assignments = { confirmed: '人工确认', matched: '自动匹配', ambiguous: '歧义待核', unassigned: '未归属' };
  const assignmentReasons = { ...reasons, unknown_speaker: '未区分说话人', mixed_confirmed_people: '本组标注冲突',
    partial_confirmation: '部分片段已标注', stable_voice_confirmation: '关联已确认声音', no_embedding: '未提取声纹',
    below_threshold: '相似程度不足', no_compatible_samples: '暂无可匹配样本' };
  let snapshot = { people: [] }, reviewData, reviewSignature, revision;
  let view = views.includes(localStorage.getItem('voice-review-view')) ? localStorage.getItem('voice-review-view') : 'recordings';
  let page = 1, navigationGeneration = 0, reviewRequest, pollTimer;
  let selected, detail, detailGeneration = 0, detailPending = false, formDirty = false;
  let expanded, memberPage = 1, memberData, memberGeneration = 0, membersPending = false;
  let segmentPage = 1, segmentData, segmentGeneration = 0, editing;
  let historyIndex;
  let busy = false, refreshing = false, audio, playbackGeneration = 0, playbackLoading = false;
  let playback, seeking = false;
  let progressGeneration = 0, progressBusy = false, listPending = false, baseGeneration = 0;
  let peopleSignature = '', optionsSignature = '';
  let partialPage = 1, partialPagination, partialSignature;
  const representativeCache = new Map();
  const key = (g) => `${g.recordingId}:${g.speakerLabel}`;
  const ref = (g) => ({ recordingId: g.recordingId, speakerLabel: g.speakerLabel });
  const icons = () => window.lucide?.createIcons();
  const text = (tag, value, className) => {
    const el = document.createElement(tag); el.textContent = value;
    if (className) el.className = className;
    return el;
  };
  const icon = (name) => { const el = document.createElement('i'); el.dataset.lucide = name; return el; };
  const iconButton = (name, label) => {
    const el = text('button', '', 'icon'); el.type = 'button'; el.title = label;
    el.setAttribute('aria-label', label); el.append(icon(name)); return el;
  };
  const localTime = (value) => value && Number.isFinite(new Date(value).getTime())
    ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '时间未记录';
  const bucketTitle = (b) => b.name || (b.kind === 'person' ? '未命名人物'
    : b.kind === 'ambiguous' ? '待核对声音' : b.kind === 'unassigned' ? '未归属声音' : '未命名声音');
  const voiceTitle = (g) => g.personName || g.assignment?.personName || g.associatedPerson?.personName
    || (g.stableVoiceId ? `声音 ${g.stableVoiceId.slice(-8)}` : '未命名声音');
  const dialogOpen = () => Boolean(document.querySelector('dialog[open]'));
  const inputFocused = () => document.activeElement?.matches('select,input,textarea');
  const structureProtected = () => dialogOpen() || inputFocused() || $('groups').contains(document.activeElement);
  const detailProtected = () => busy || formDirty || dialogOpen() || inputFocused();
  function status(message, error = false) { $('status').textContent = message; $('status').className = error ? 'error' : ''; }
  function stopAudio() {
    playbackGeneration++; audio?.pause(); audio = null; playback = null; playbackLoading = false; seeking = false;
    $('playback').hidden = true; playbackButton(); controls();
  }
  function playbackButton() {
    const playing = audio && !audio.paused;
    const label = playing ? '暂停试听' : playback ? '继续试听' : '听完整录音';
    $('listen').replaceChildren(icon(playing ? 'pause' : 'play'), text('span', label));
    $('listen').title = label; icons();
  }
  function updatePlayback() {
    if (!playback?.sample) return;
    const { sample } = playback;
    const position = Math.min(sample.durationMs, sample.offsetMs + (audio?.currentTime || 0) * 1000);
    const time = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
    $('playback').hidden = false;
    $('playbackSeek').max = sample.durationMs / 1000;
    if (!seeking) $('playbackSeek').value = position / 1000;
    $('playbackTime').textContent = `${time(position)} / ${time(sample.durationMs)}`;
    $('playbackScope').textContent = playback.segmentId ? '当前文字片段' : '完整录音';
  }
  function controls() {
    for (const el of document.querySelectorAll('button,input,select,textarea')) {
      if (!el.closest('#partialSection,#samplesDialog')) el.disabled = busy;
    }
    $('refresh').disabled = busy || refreshing;
    $('previousPage').disabled = busy || !reviewData?.pagination?.hasPrevious;
    $('nextPage').disabled = busy || !reviewData?.pagination?.hasNext;
    $('previousSegments').disabled = busy || !segmentData?.pagination?.hasPrevious;
    $('nextSegments').disabled = busy || !segmentData?.pagination?.hasNext;
    for (const el of document.querySelectorAll('[data-member-page]')) {
      el.disabled = busy || !memberData?.pagination?.[el.dataset.memberPage === '-1' ? 'hasPrevious' : 'hasNext'];
    }
    $('enroll').disabled = busy || !detail?.canEnroll;
    $('listen').disabled = busy || playbackLoading || !detail?.sampleAvailable;
    $('playbackSeek').disabled = busy || playbackLoading || !playback?.sample;
    $('save').disabled = busy || !detail || Boolean(detail.disabledReason) || detail.speakerLabel === 'unknown';
    $('revoke').disabled = busy || !detail;
  }
  function setBusy(value) { busy = value; controls(); }
  function pagerLabel(pagination, unit) {
    return pagination ? `${pagination.page} / ${Math.max(1, pagination.totalPages)} · ${pagination.total} ${unit}` : '正在加载';
  }
  function renderMatching(data) {
    const labels = { loading: '正在加载声音', refreshing: '正在重新匹配', ready: '匹配已更新', error: '匹配失败' };
    const loaded = data.progress?.loaded ?? 0, total = data.progress?.total ?? 0;
    $('matchingState').textContent = `${labels[data.state] || '正在加载声音'} · 已加载 ${loaded} / ${total} 份录音${data.error ? ` · ${data.error}` : ''}`;
    $('matchingState').className = data.state === 'error' ? 'error' : '';
    $('matchingProgress').hidden = data.state === 'ready' || data.state === 'error';
    $('matchingProgress').max = Math.max(1, total); $('matchingProgress').value = loaded;
    for (const name of ['confirmed', 'matched', 'ambiguous', 'unassigned', 'recommended']) {
      $(name + 'Count').textContent = data.counts?.[name] ?? '--';
    }
    $('groupCount').textContent = view === 'recordings' ? data.pagination?.total ?? '--' : snapshot.counts?.recordings ?? '--';
  }
  function syncPeopleOptions(value = $('personSelect').value) {
    if (optionsSignature !== peopleSignature) {
      $('personSelect').replaceChildren(new Option('选择人物', ''), ...snapshot.people.map(p => new Option(p.name, p.id)));
      optionsSignature = peopleSignature;
    }
    $('personSelect').value = value || '';
  }
  async function loadBase() {
    const generation = ++baseGeneration;
    const data = await api.snapshot({ status: 'all', page: 1, pageSize: 1 });
    if (generation !== baseGeneration) return;
    snapshot = data;
    await loadPartials();
    $('environment').textContent = data.isolated ? '隔离预览 · 示例数据 · 不接入 Agent' : '本机声纹库';
    const signature = JSON.stringify(data.people);
    if (signature === peopleSignature) return;
    peopleSignature = signature;
    $('people').replaceChildren(...data.people.map(p => {
      const row = text('button', '', 'person'), body = text('span', p.name, 'person-body');
      row.type = 'button'; row.disabled = busy; row.dataset.personId = p.id; row.dataset.personName = p.name;
      row.title = `管理${p.name}的声纹样本`;
      row.setAttribute('aria-haspopup', 'dialog'); row.setAttribute('aria-controls', 'samplesDialog');
      body.append(text('small', `${p.sampleCount} 个声纹样本`));
      row.append(text('span', p.name.slice(0, 1), 'avatar'), body, icon('chevron-right')); return row;
    }));
    if (!data.people.length) $('people').append(text('p', '尚未添加人物', 'muted'));
    icons();
    if (!dialogOpen() && !inputFocused()) syncPeopleOptions(!formDirty && detail ? preferredPerson(detail) : $('personSelect').value);
  }
  async function loadPartials() {
    if (!api.partials) return;
    try {
      const data = await api.partials({ page: partialPage, pageSize: 5 });
      const signature = JSON.stringify(data);
      if (signature === partialSignature) return;
      partialSignature = signature;
      partialPagination = data.pagination;
      $('partialSection').hidden = !data.pagination.total;
      $('partialPageLabel').textContent = pagerLabel(data.pagination, '份录音');
      $('previousPartials').disabled = !data.pagination.hasPrevious;
      $('nextPartials').disabled = !data.pagination.hasNext;
      $('partialRecordings').replaceChildren(...data.recordings.map(record => {
        const entry = document.createElement('details');
        entry.append(text('summary', `${record.title} · ${localTime(record.recordedAt)} · ${record.partialCount} 个未完成片段`));
        const body = text('div', '', 'partial-body'); entry.append(body);
        let loaded = false;
        entry.addEventListener('toggle', async () => {
          if (!entry.open || loaded) return;
          loaded = true;
          async function show(page = 1) {
            try {
              const result = await api.partials({ recordingId: record.recordingId, page, pageSize: 5 });
              body.replaceChildren(...result.partials.map(part => {
                const block = text('div', '', 'partial-result');
                const reason = ({output_token_limit: '输出长度上限', audio_duration_deadline: '推理超时',
                  invalid_model_output: '输出格式未完成', worker_error: '识别运行失败'})[part.stopReason] ?? '转写未完成';
                block.append(text('small', `${(part.startMs / 1000).toFixed(1)}–${(part.endMs / 1000).toFixed(1)} 秒 · ${reason} · 未进入知识库`),
                  text('pre', part.text || (part.stopReason === 'audio_duration_deadline'
                    ? '截止时尚无已生成文字' : '暂无已保存文字')));
                return block;
              }));
              const pager = text('div', '', 'pager');
              for (const [delta, label] of [[-1, '上一页片段'], [1, '下一页片段']]) {
                const button = iconButton(delta < 0 ? 'chevron-left' : 'chevron-right', label);
                button.disabled = !result.pagination[delta < 0 ? 'hasPrevious' : 'hasNext'];
                button.addEventListener('click', () => show(result.pagination.page + delta));
                pager.append(button);
              }
              body.append(pager); icons();
            } catch { body.replaceChildren(text('p', '未完成文字暂不可读', 'error')); loaded = false; }
          }
          await show();
        });
        return entry;
      }));
      icons();
    } catch { status('未完成转写列表暂不可读', true); }
  }
  $('previousPartials').addEventListener('click', () => { if (partialPagination?.hasPrevious) { partialPage--; loadPartials(); } });
  $('nextPartials').addEventListener('click', () => { if (partialPagination?.hasNext) { partialPage++; loadPartials(); } });
  function markSelection() {
    for (const el of document.querySelectorAll('.bucket')) {
      el.classList.toggle('selected', el.dataset.bucketId === selected?.bucketId);
      el.querySelector('.bucket-select').setAttribute('aria-pressed', String(el.dataset.bucketId === selected?.bucketId));
    }
    for (const el of document.querySelectorAll('.group')) {
      const active = el.dataset.key === (selected && key(selected));
      el.classList.toggle('selected', active); el.setAttribute('aria-pressed', String(active));
    }
  }
  function groupRow(g, bucket) {
    const row = text('button', '', 'group'); row.type = 'button'; row.dataset.key = key(g);
    const mark = text('span', '', 'voice-mark'); mark.append(icon('audio-lines'));
    const body = text('span', '', 'group-text');
    body.append(text('b', g.recording ? (g.title || '录音') : voiceTitle(g)), text('small', `${localTime(g.recordedAt)} · ${g.segmentCount} 段文字${g.recording ? ` · ${g.speakerCount} 个声音组` : ''}`));
    if (g.excerpt) body.append(text('small', g.excerpt));
    const kind = g.assignment?.kind || (g.personId ? 'confirmed' : 'unassigned');
    body.append(text('small', g.recordingId));
    row.append(mark, body, text('span', g.recording ? (g.transcriptDigest ? 'MOSS 新版' : '旧转写') : assignments[kind], `tag ${kind}`));
    row.addEventListener('click', () => selectGroup(g, { bucket, summary: g }));
    return row;
  }
  function bucketRow(b) {
    const row = text('article', '', 'bucket'); row.dataset.bucketId = b.id; row.dataset.kind = b.kind;
    if (b.personId) row.dataset.personId = b.personId;
    const heading = text('div', '', 'bucket-heading'), choose = text('button', '', 'bucket-select'); choose.type = 'button';
    const mark = text('span', '', 'voice-mark'); mark.append(icon(b.kind === 'person' ? 'user-round' : 'audio-lines'));
    const body = text('span', '', 'bucket-body');
    body.append(text('span', bucketTitle(b), 'bucket-title'));
    body.append(text('span', `${b.recordingCount} 份录音 · ${b.groupCount} 个录音组${b.taskCount ? ` · ${b.taskCount} 处任务关联` : ''}`, 'bucket-meta'));
    const counts = text('span', '', 'bucket-counts');
    for (const kind of ['confirmed', 'matched', 'ambiguous', 'unassigned']) {
      counts.append(text('span', `${assignments[kind]} ${b[kind + 'Count'] ?? 0} 组`, kind));
    }
    body.append(counts);
    const reason = [...new Set((b.reasonCodes || []).map(code => reasons[code]).filter(Boolean))].join(' · ');
    if (reason) body.append(text('span', reason, 'bucket-reasons'));
    const preview = text('span', b.representative ? '代表片段 · 正在读取' : '暂无录音片段', 'representative');
    if (b.representative) preview.dataset.representative = key(b.representative);
    body.append(preview); choose.append(mark, body);
    choose.addEventListener('click', () => {
      if (b.representative) selectGroup(b.representative, { bucket: b, representative: true });
    });
    const expand = iconButton(expanded === b.id ? 'chevron-up' : 'chevron-down', `展开或收起${bucketTitle(b)}的录音组`);
    expand.classList.add('expand-bucket'); expand.setAttribute('aria-expanded', String(expanded === b.id));
    expand.addEventListener('click', () => toggleBucket(b));
    heading.append(choose, expand); row.append(heading);
    if (expanded === b.id) row.append(memberPanel(b));
    return row;
  }
  function memberPanel(b) {
    const panel = text('div', '', 'members'); panel.dataset.bucketId = b.id;
    panel.append(text('p', `${bucketTitle(b)} · 录音组`, 'members-heading'));
    if (memberData?.bucketId === b.id) {
      panel.append(...memberData.groups.map(g => groupRow(g, b)));
      if (!memberData.groups.length) panel.append(text('p', '暂无录音组', 'muted'));
      const pager = text('div', '', 'pager');
      for (const delta of [-1, 1]) {
        if (delta === 1) pager.append(text('span', pagerLabel(memberData.pagination, '组')));
        const button = iconButton(delta < 0 ? 'chevron-left' : 'chevron-right', delta < 0 ? '上一页成员' : '下一页成员');
        button.dataset.memberPage = delta;
        button.addEventListener('click', () => { if (!busy) { memberPage += delta; loadMembers(true); } });
        pager.append(button);
      }
      panel.append(pager);
    } else panel.append(text('p', '正在加载录音组', 'muted'));
    return panel;
  }
  function renderList() {
    listPending = false;
    const scroll = $('groups').scrollTop, rows = [];
    if (view === 'recordings') rows.push(...(reviewData.groups || []).map(g => groupRow(g)));
    else if (view === 'people') {
      for (const [kind, label] of [['person', '人物'], ['voice', '未命名声音'], ['ambiguous', '歧义声音'], ['unassigned', '未归属声音']]) {
        const items = (reviewData.items || []).filter(b => b.kind === kind);
        if (items.length) rows.push(text('h2', label, 'bucket-section'), ...items.map(bucketRow));
      }
    } else rows.push(...(reviewData.items || []).map(bucketRow));
    $('groups').replaceChildren(...rows); $('groups').scrollTop = scroll;
    $('pageLabel').textContent = pagerLabel(reviewData.pagination, view === 'recordings' ? '份录音' : '项声音');
    $('empty').hidden = rows.length > 0;
    $('empty').textContent = reviewData.state === 'loading' ? '正在加载声音'
      : reviewData.state === 'error' ? '声音列表暂不可用'
        : view === 'recommended' ? '暂无优先标注声音' : view === 'people' ? '暂无人物或声音' : '暂无录音';
    membersPending = false; markSelection(); controls(); icons(); hydrateRepresentatives();
    if (!selected && !dialogOpen()) {
      const first = reviewData.items?.find(b => b.representative);
      if (first) selectGroup(first.representative, { bucket: first, representative: true });
      else if (reviewData.groups?.length) selectGroup(reviewData.groups[0], { summary: reviewData.groups[0] });
    }
  }
  async function hydrateRepresentatives() {
    const capturedRevision = revision;
    const queue = [...$('groups').querySelectorAll('[data-representative]')];
    async function next() {
      const node = queue.shift(); if (!node || capturedRevision !== revision || !node.isConnected) return;
      const b = reviewData.items.find(b => key(b.representative || {}) === node.dataset.representative);
      if (b) {
        try {
          const cacheKey = `${capturedRevision}:${key(b.representative)}`;
          if (!representativeCache.has(cacheKey)) representativeCache.set(cacheKey, api.group(ref(b.representative)));
          const g = await representativeCache.get(cacheKey);
          if (node.isConnected && capturedRevision === revision) node.textContent = `代表片段 · ${g.excerpt || '无可用文字摘录'}`;
        } catch { if (node.isConnected) node.textContent = '代表片段暂不可用'; }
      }
      await next();
    }
    // Bound detail reads when a page contains many voice buckets.
    for (let i = 0; i < 3; i++) void next();
  }
  async function toggleBucket(b) {
    if (busy) return;
    expanded = expanded === b.id ? null : b.id; memberPage = 1; memberData = null; memberGeneration++;
    renderList();
    if (expanded) {
      if (b.representative && selected?.bucketId !== b.id) selectGroup(b.representative, { bucket: b, representative: true });
      await loadMembers(true);
    }
  }
  async function loadMembers(interactive = false) {
    if (!expanded) return;
    const id = expanded, generation = ++memberGeneration, currentView = view;
    try {
      const data = await api.review({ view: currentView, bucketId: id, page: memberPage, pageSize: 30 });
      if (generation !== memberGeneration || expanded !== id || currentView !== view) return;
      memberData = { ...data, groups: data.groups || [], bucketId: id }; memberPage = data.pagination?.page || 1;
      const summary = memberData.groups.find(g => selected && key(g) === key(selected));
      if (summary) { selected.summary = summary; detailPending = true; }
      membersPending = true;
      if (interactive) renderMembers();
      flushDeferred();
    } catch (e) { if (generation === memberGeneration) status(`读取录音组失败：${e.message}`, true); }
  }
  function renderMembers() {
    const panel = [...document.querySelectorAll('.members')].find(el => el.dataset.bucketId === expanded);
    const bucket = reviewData?.items?.find(b => b.id === expanded);
    const focusedPage = document.activeElement?.dataset.memberPage;
    if (panel && bucket) {
      panel.replaceWith(memberPanel(bucket)); markSelection(); controls(); icons();
      if (focusedPage) document.querySelector(`[data-member-page="${focusedPage}"]`)?.focus();
    }
    membersPending = false;
  }
  function flushDeferred() {
    if (!structureProtected()) {
      if (listPending && reviewData) renderList();
      else if (membersPending && expanded) {
        renderMembers();
      }
    }
    if (!dialogOpen() && !inputFocused()) syncPeopleOptions();
    if (detailPending && !detailProtected()) { detailPending = false; void loadDetail(); }
  }
  function schedulePoll(delay) { clearTimeout(pollTimer); pollTimer = setTimeout(pollReview, delay); }
  async function pollReview() {
    clearTimeout(pollTimer);
    const generation = navigationGeneration;
    if (reviewRequest?.generation === generation) return reviewRequest.promise;
    const promise = (async () => {
      try {
        let data = await api.review({ view, page, pageSize: 30 });
        if (view === 'recordings' && api.recordings) {
          const recordings = await api.recordings({ page, pageSize: 30 });
          data = { ...data, ...recordings, revision: JSON.stringify([data.revision, recordings]) };
        }
        if (generation !== navigationGeneration) return;
        const signature = JSON.stringify([view, page, data.revision, data.state, data.progress, data.error]);
        const changedRevision = revision !== data.revision;
        reviewData = data; page = data.pagination?.page || page;
        if (signature !== reviewSignature) {
          reviewSignature = signature; renderMatching(data); listPending = true;
          if (changedRevision) {
            revision = data.revision; representativeCache.clear();
            detailPending = Boolean(selected);
            void loadBase().catch(e => status(`人物信息暂不可用：${e.message}`, true));
          }
          const summary = data.groups?.find(g => selected && key(g) === key(selected));
          if (summary) selected.summary = summary;
          if (expanded) void loadMembers();
        }
        flushDeferred(); controls();
      } catch (e) {
        if (generation === navigationGeneration) {
          $('matchingState').textContent = `读取匹配结果失败：${e.message}`; $('matchingState').className = 'error';
        }
      } finally {
        if (generation === navigationGeneration) {
          reviewRequest = null; schedulePoll(reviewData?.state === 'ready' ? 4000 : 1000);
        }
      }
    })();
    reviewRequest = { generation, promise }; return promise;
  }
  function changeView(next) {
    if (busy) return;
    localStorage.setItem('voice-review-view', next);
    view = next; page = 1; expanded = null; memberData = null; memberGeneration++;
    navigationGeneration++; reviewSignature = null; reviewData = null; listPending = false;
    for (const name of views) {
      const active = name === view, tab = $(name + 'Tab');
      tab.classList.toggle('selected', active); tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
    }
    $('reviewPanel').setAttribute('aria-labelledby', view + 'Tab');
    $('groups').replaceChildren(); $('pageLabel').textContent = '正在加载'; $('empty').hidden = true;
    controls(); void pollReview();
  }
  async function selectGroup(g, { bucket, summary, representative = false } = {}) {
    if (busy) return;
    stopAudio(); selected = { ...ref(g), bucketId: bucket?.id, bucketName: bucket && bucketTitle(bucket),
      summary: summary || (bucket && { assignment: { kind: bucket.kind === 'person' ? 'matched'
        : bucket.kind === 'ambiguous' ? 'ambiguous' : 'unassigned', personId: bucket.personId, personName: bucket.name } }), representative };
    detail = null; formDirty = false; segmentPage = 1; segmentData = null; historyIndex = undefined; segmentGeneration++; progressGeneration++;
    $('segments').replaceChildren(); $('detail').hidden = false; $('detail').dataset.key = key(g);
    $('selectedTitle').textContent = '正在读取录音组'; $('excerpt').textContent = '';
    $('assignmentState').textContent = ''; $('reviewState').textContent = ''; $('scope').textContent = '';
    $('enroll').checked = false; $('personSelect').value = ''; detailPending = false;
    markSelection(); controls(); await loadDetail();
  }
  function currentAssignment(g) {
    if (g.personId) return { kind: 'confirmed', personId: g.personId, personName: g.personName };
    if (g.disabledReason === 'mixed_confirmed_people') return { kind: 'ambiguous', reason: '本组存在不同人物标注' };
    return g.assignment || selected?.summary?.assignment
      || (g.associatedPerson ? { kind: 'matched', ...g.associatedPerson } : { kind: 'unassigned' });
  }
  function preferredPerson(g) {
    const assignment = currentAssignment(g);
    return g.personId || (assignment.kind === 'matched'
      ? assignment.personId || assignment.candidates?.[0]?.personId || g.associatedPerson?.personId : '') || '';
  }
  async function loadDetail({ force = false, preserveDraft = formDirty } = {}) {
    if (!selected) return;
    const target = selected, generation = ++detailGeneration;
    try {
      // Only full group details carry the revision token used for writes.
      let g;
      try { g = await api.group(ref(target)); }
      catch (error) {
        const timeline = await api.timeline({ recordingId: target.recordingId });
        if (timeline.speakers.length) {
          target.speakerLabel = timeline.speakers[0].speakerLabel;
          g = await api.group(ref(target));
        } else g = { ...ref(target), recordedAt: timeline.recordedAt, title: timeline.title,
          sampleAvailable: true, disabledReason: 'unknown_speaker', segmentCount: 0 };
      }
      if (generation !== detailGeneration || selected !== target) return;
      if (!force && detailProtected()) { detailPending = true; return; }
      detail = g; $('detail').hidden = false; $('detail').dataset.key = key(g);
      $('selectedTitle').textContent = g.title || '录音';
      $('detailContext').textContent = localTime(g.recordedAt);
      $('excerpt').textContent = g.excerpt || '无可用文字摘录';
      const assignment = currentAssignment(g), candidates = assignment.candidates || [];
      const candidateNames = ['matched', 'ambiguous'].includes(assignment.kind)
        ? [...new Set(candidates.slice(0, 3).map(c => c.personName).filter(Boolean))] : [];
      $('assignmentState').className = `assignment-state ${assignment.kind}`;
      $('assignmentState').textContent = `${assignments[assignment.kind]}${assignment.personName ? ` · ${assignment.personName}` : ''}${candidateNames.length ? ` · 候选：${candidateNames.join('、')}` : ''}${assignment.reason && assignmentReasons[assignment.reason] ? ` · ${assignmentReasons[assignment.reason]}` : ''}${assignment.kind === 'matched' ? ' · 尚未人工确认' : ''}`;
      if (!preserveDraft) {
        syncPeopleOptions(preferredPerson(g)); $('enroll').checked = false;
      }
      if (!g.canEnroll) $('enroll').checked = false;
      $('sampleHint').textContent = g.speakerLabel === 'unknown' ? '未区分说话人的片段不能整组登记。'
        : g.disabledReason ? '这组声音已有不同人物标注，请逐段核对。'
          : g.canEnroll ? `${g.personId ? '当前录音组已人工确认' : '人名预选尚未保存'}；仅在勾选后登记声纹样本。` : '此组没有可登记的声纹样本。';
      $('scope').textContent = `仅确认当前录音组 · ${g.segmentCount} 段文字 · ${localTime(g.recordedAt)} · ${g.recordingId}${g.stableVoiceId ? ` · ${g.stableVoiceId}` : ''}`;
      $('revoke').hidden = !g.personId && g.disabledReason !== 'mixed_confirmed_people';
      void loadSegments(g); updateProgress(g); controls();
    } catch (e) { if (generation === detailGeneration) status(`读取录音组失败：${e.message}`, true); }
  }
  async function loadSegments(g) {
    const generation = ++segmentGeneration;
    try {
      const data = await api.timeline({ recordingId: g.recordingId, historyIndex, page: segmentPage, pageSize: 20 });
      if (generation !== segmentGeneration || !selected || key(selected) !== key(g)) return;
      segmentData = data; segmentPage = data.pagination.page;
      $('transcriptVersion').replaceChildren(new Option('当前转写', ''), ...data.history.map(h => new Option(
        `旧版 ${h.index + 1} · ${h.annotatedCount} 段人工标注`, String(h.index))));
      $('transcriptVersion').value = historyIndex === undefined ? '' : String(historyIndex);
      $('confirmForm').hidden = historyIndex !== undefined || !data.speakers.length;
      $('annotationCount').textContent = `已标注 ${data.confirmedCount} / ${data.pagination.total} 段 · 未确认 ${data.pagination.total - data.confirmedCount} 段`;
      $('speakerFocus').replaceChildren(...data.speakers.map(s => {
        const button = text('button', s.personName || (s.speakerLabel === 'unknown' ? '未区分' : `说话人 ${s.ordinal}`), `speaker-chip tone-${(s.ordinal - 1) % 5}`);
        button.type = 'button'; button.classList.toggle('active', s.speakerLabel === g.speakerLabel);
        button.setAttribute('aria-pressed', String(s.speakerLabel === g.speakerLabel));
        button.addEventListener('click', () => { if (historyIndex === undefined) selectGroup({ recordingId: g.recordingId, speakerLabel: s.speakerLabel }); });
        return button;
      }));
      const current = data.speakers.find(s => s.speakerLabel === g.speakerLabel);
      $('confirmLabel').textContent = `${current?.personName || (current ? `说话人 ${current.ordinal}` : '当前声音组')} 是哪位？`;
      $('segmentPageLabel').textContent = pagerLabel(data.pagination, '段文字');
      $('segments').replaceChildren(...data.segments.map(s => {
        const row = text('div', '', `segment tone-${(s.ordinal - 1) % 5}`), body = text('div', '');
        body.append(text('small', `${localTime(Date.parse(g.recordedAt) + s.startMs)} · ${s.personName || `说话人 ${s.ordinal} · 未确认`}`), text('p', s.text));
        const listen = iconButton('play', '试听此片段');
        listen.addEventListener('click', () => playSample({ ...g, speakerLabel: s.speakerLabel }, s.segmentId));
        const edit = iconButton('pencil', '标注此片段');
        edit.addEventListener('click', () => {
          editing = { ...s, recordingId: g.recordingId };
          $('segmentPerson').replaceChildren(new Option('未确认人物', ''), ...snapshot.people.map(p => new Option(p.name, p.id)));
          $('segmentPerson').value = s.personId || ''; $('segmentText').value = s.text;
          $('segmentError').textContent = ''; $('segmentDialog').showModal();
        });
        row.append(body);
        if (historyIndex === undefined) row.append(listen, edit);
        return row;
      }));
      controls(); icons();
    } catch (e) { if (generation === segmentGeneration) status(e.message, true); }
  }
  function updateProgress(g) {
    const generation = ++progressGeneration; progressBusy = true;
    api.progress({ recordingId: g.recordingId }).then(value => {
      if (generation !== progressGeneration || !selected || key(selected) !== key(g)) return;
      const names = { pending: '等待 Agent 复核', leased: 'Agent 正在处理', acknowledged: '源会话已处理增量' };
      const k = value.deliveries?.knowledge, t = value.deliveries?.tasks;
      $('reviewState').textContent = `${names[value.review?.status] || '暂无处理事件'}${k?.total ? ` · 知识整理 ${k.acknowledged}/${k.total}` : ''}${t?.total ? ` · 任务增量 ${t.acknowledged}/${t.total}` : ''}${value.review?.note ? ` · ${value.review.note}` : ''}`;
    }).catch(() => { if (generation === progressGeneration) $('reviewState').textContent = '处理状态暂不可用'; })
      .finally(() => { if (generation === progressGeneration) progressBusy = false; });
  }
  async function playSample(g, segmentId, offsetMs = 0, autoplay = true) {
    stopAudio(); const generation = ++playbackGeneration; playbackLoading = true; controls();
    try {
      const sample = await api.sample({ ...ref(g), segmentId, offsetMs });
      if (generation !== playbackGeneration) return;
      if (!sample.dataUrl) throw new Error('原音频已清理或暂不可用');
      playback = { g, segmentId, sample };
      audio = new Audio(sample.dataUrl);
      audio.ontimeupdate = () => { if (generation === playbackGeneration) updatePlayback(); };
      audio.onended = () => {
        if (generation !== playbackGeneration) return;
        if (sample.nextOffsetMs !== null) void playSample(g, segmentId, sample.nextOffsetMs);
        else { updatePlayback(); playbackButton(); }
      };
      audio.onerror = () => {
        if (generation === playbackGeneration) { stopAudio(); status('录音播放失败，原音频未修改', true); }
      };
      updatePlayback();
      if (autoplay) await audio.play();
      if (generation === playbackGeneration) playbackButton();
    } catch (e) { if (generation === playbackGeneration) { stopAudio(); status(e.message, true); } }
    finally { if (generation === playbackGeneration) { playbackLoading = false; controls(); } }
  }
  async function afterMutation({ preserveDraft = false } = {}) {
    // Writes invalidate the backend index; polling observes completion without requesting another rebuild.
    navigationGeneration++; reviewRequest = null; detailPending = false; representativeCache.clear();
    if (selected) selected.summary = null;
    if (!preserveDraft) formDirty = false;
    await loadBase(); await loadDetail({ force: true, preserveDraft }); schedulePoll(0);
  }
  for (const name of views) {
    $(name + 'Tab').addEventListener('click', () => changeView(name));
    $(name + 'Tab').addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? 2
        : (views.indexOf(name) + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
      changeView(views[index]); $(views[index] + 'Tab').focus();
    });
  }
  for (const [id, delta] of [['previousPage', -1], ['nextPage', 1]]) $(id).addEventListener('click', () => {
    if (busy) return;
    page += delta; navigationGeneration++; reviewSignature = null; expanded = null; memberGeneration++;
    $('groups').scrollTop = 0; void pollReview();
  });
  for (const [id, delta] of [['previousSegments', -1], ['nextSegments', 1]]) $(id).addEventListener('click', () => {
    if (!busy && detail) { segmentPage += delta; void loadSegments(detail); }
  });
  $('transcriptVersion').addEventListener('change', () => {
    historyIndex = $('transcriptVersion').value === '' ? undefined : Number($('transcriptVersion').value);
    segmentPage = 1; if (detail) void loadSegments(detail);
  });
  for (const id of ['personSelect', 'enroll']) $(id).addEventListener('change', () => { formDirty = true; });
  document.addEventListener('focusout', () => setTimeout(flushDeferred, 0));
  for (const name of ['Person', 'Segment']) {
    $('cancel' + name).addEventListener('click', () => $(name.toLowerCase() + 'Dialog').close());
    $(name.toLowerCase() + 'Dialog').addEventListener('close', () => setTimeout(flushDeferred, 0));
    $(name.toLowerCase() + 'Dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  }
  $('refresh').addEventListener('click', async () => {
    if (refreshing || busy) return;
    refreshing = true; controls();
    try {
      const state = await api.reviewRefresh();
      renderMatching({ ...reviewData, ...state, counts: state.counts || reviewData?.counts });
      // An unchanged content revision can finish before the next poll observes refreshing.
      navigationGeneration++; reviewRequest = null; reviewSignature = null;
      status('已请求重新匹配已有声音，未重新识别文字'); schedulePoll(0);
    } catch (e) { status(e.message, true); }
    finally { refreshing = false; controls(); }
  });
  $('addPerson').addEventListener('click', () => {
    $('personName').value = ''; $('personError').textContent = ''; $('personDialog').showModal(); $('personName').focus();
  });
  document.addEventListener('voice-samples-opened', stopAudio);
  document.addEventListener('voice-samples-changed', () => {
    void loadBase().catch(e => status(e.message, true));
    schedulePoll(0);
  });
  $('personForm').addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    try {
      setBusy(true); const p = await api.createPerson({ name: $('personName').value.trim() });
      await loadBase(); syncPeopleOptions(p.id); formDirty = true;
      $('personDialog').close(); schedulePoll(0); status('人物已添加，当前录音尚未确认');
    } catch (e) { $('personError').textContent = e.message; }
    finally { setBusy(false); }
  });
  $('confirmForm').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !detail) return;
    const g = detail, enroll = $('enroll').checked, personId = $('personSelect').value;
    try {
      setBusy(true);
      const result = await api.confirm({ ...ref(g), personId, revisionToken: g.revisionToken, enroll });
      if (result.skipped) throw new Error('这组声音暂不能整体确认，请逐段核对。');
      stopAudio(); await afterMutation();
      status(enroll ? '当前录音组人物已确认，声纹样本已保存；已排队通知 Agent 复核' : '当前录音组人物已确认，未新增声纹样本；已排队通知 Agent 复核');
    } catch (e) { status(e.message, true); }
    finally { setBusy(false); }
  });
  $('revoke').addEventListener('click', async () => {
    if (busy || !detail) return;
    const g = detail;
    try {
      setBusy(true); await api.revoke({ ...ref(g), revisionToken: g.revisionToken });
      stopAudio(); await afterMutation(); status('已撤销当前录音组标注和声纹样本；已排队通知 Agent 复核');
    } catch (e) { status(e.message, true); }
    finally { setBusy(false); }
  });
  $('segmentForm').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !editing) return;
    try {
      setBusy(true);
      await api.reviseSegment({ ...ref(editing), segmentId: editing.segmentId, revision: editing.revision,
        text: $('segmentText').value, personId: $('segmentPerson').value || null });
      $('segmentDialog').close(); await afterMutation({ preserveDraft: formDirty });
      status('片段标注已保存；已排队通知 Agent 复核');
    } catch (e) { $('segmentError').textContent = e.message; }
    finally { setBusy(false); }
  });
  $('listen').addEventListener('click', async () => {
    if (!audio) { if (detail) void playSample(detail); return; }
    if (!audio.paused) { audio.pause(); playbackButton(); return; }
    if (audio.ended && playback) { void playSample(playback.g, playback.segmentId); return; }
    const generation = playbackGeneration;
    try { await audio.play(); if (generation === playbackGeneration) playbackButton(); }
    catch (e) { if (generation === playbackGeneration) { stopAudio(); status(e.message, true); } }
  });
  $('playbackSeek').addEventListener('input', () => { seeking = true; });
  $('playbackSeek').addEventListener('change', () => {
    if (!playback?.sample) return;
    const { g, segmentId, sample } = playback;
    const offsetMs = Math.min(Number($('playbackSeek').value) * 1000, Math.max(0, sample.durationMs - 1));
    void playSample(g, segmentId, offsetMs, Boolean(audio && !audio.paused));
  });
  icons(); window.shadowMascot?.setState('idle'); controls();
  setInterval(() => {
    if (detail && !busy && !progressBusy && !document.hidden) updateProgress(detail);
  }, 5000);
  void loadBase().catch(e => status(`读取人物失败：${e.message}`, true));
  if (typeof api.review === 'function' && typeof api.group === 'function' && typeof api.reviewRefresh === 'function') changeView(view);
  else status('声音标注接口尚未接入：需要 review、reviewRefresh 和 group。', true);
})();
