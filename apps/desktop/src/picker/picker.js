(() => {
  const bridge = window.rajcordCapturePicker;
  const status = document.getElementById('status');
  const list = document.getElementById('sources');
  const sound = document.getElementById('sound');
  const system = document.getElementById('system-sound');
  const application = document.getElementById('application-sound');
  const help = document.getElementById('sound-help');
  const audioSummary = document.getElementById('audio-summary');
  const confirm = document.getElementById('confirm');
  const cancel = document.getElementById('cancel');
  const selectedLabel = document.getElementById('selected-label');
  const sourcePanel = document.getElementById('source-panel');
  const tabs = [...document.querySelectorAll('[data-kind-tab]')];
  const counts = {
    window: document.getElementById('window-count'),
    screen: document.getElementById('screen-count'),
  };
  let snapshot,
    selected,
    kind = 'window',
    busy = false,
    ended = false;
  const radios = [...document.querySelectorAll('input[name=sound]')];
  const soundLabels = {
    none: 'Video only',
    application: 'Selected app audio, including its child processes and other windows',
    system: 'System audio from other apps, excluding Rajcord',
    source: 'Automatic — application audio for a window, system audio for an entire screen',
  };
  const selectedSound = () =>
    snapshot?.sound === 'source'
      ? selected?.kind === 'window'
        ? 'application'
        : 'system'
      : (snapshot?.sound ?? radios.find((radio) => radio.checked)?.value);
  const message = (text) => {
    status.textContent = text;
  };
  const update = () => {
    const compatible = selected?.sounds.includes(selectedSound());
    confirm.disabled = ended || busy || !selected || !compatible;
    if (snapshot?.sound) {
      audioSummary.textContent =
        'Audio: ' +
        soundLabels[selected ? selectedSound() : snapshot.sound] +
        (selected && !compatible
          ? '. This source cannot provide that audio. Choose another source.'
          : '');
    }
  };
  const clearSelection = () => {
    selected = undefined;
    selectedLabel.textContent = 'No source selected';
    for (const button of list.querySelectorAll('button'))
      button.setAttribute('aria-pressed', 'false');
    radios.forEach((radio) => {
      radio.checked = false;
    });
    sound.disabled = true;
    system.disabled = true;
    application.disabled = true;
    help.textContent = 'Select a source to see its audio options.';
    update();
  };
  const showKind = (next) => {
    kind = next;
    for (const tab of tabs) {
      const active = tab.dataset.kindTab === kind;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    }
    sourcePanel.setAttribute(
      'aria-labelledby',
      kind === 'window' ? 'tab-applications' : 'tab-screens',
    );
    for (const item of list.querySelectorAll('li')) item.hidden = item.dataset.kind !== kind;
    clearSelection();
    const available = snapshot?.sources.filter((source) => source.kind === kind).length ?? 0;
    list.dataset.empty = String(available === 0);
    message(
      available
        ? 'Select a source.'
        : `No ${kind === 'window' ? 'applications' : 'displays'} available.`,
    );
  };
  const end = (text) => {
    ended = true;
    sound.disabled = true;
    for (const button of list.querySelectorAll('button')) button.disabled = true;
    update();
    message(text);
  };
  cancel.addEventListener('click', async () => {
    if (!snapshot || ended) {
      ended = true;
      update();
      window.close();
      return;
    }
    ended = true;
    update();
    await bridge.cancel({ requestId: snapshot.requestId });
    window.close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel.click();
    }
  });
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => showKind(tab.dataset.kindTab));
    tab.addEventListener('keydown', (event) => {
      const nextIndex =
        event.key === 'ArrowRight' || event.key === 'ArrowDown'
          ? (index + 1) % tabs.length
          : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
            ? (index + tabs.length - 1) % tabs.length
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? tabs.length - 1
                : -1;
      if (nextIndex < 0) return;
      event.preventDefault();
      const next = tabs[nextIndex];
      showKind(next.dataset.kindTab);
      next.focus();
    });
  });
  radios.forEach((r) => r.addEventListener('change', update));
  confirm.addEventListener('click', async () => {
    if (confirm.disabled) return;
    busy = true;
    update();
    sound.disabled = true;
    for (const button of list.querySelectorAll('button')) button.disabled = true;
    message('Checking the selected source…');
    const result = await bridge.select({
      requestId: snapshot.requestId,
      handle: selected.handle,
      sound: selectedSound(),
    });
    if (ended) return;
    end(
      result.ok
        ? 'Source selected.'
        : 'This selection is no longer available. Cancel and choose again.',
    );
  });
  const load = async () => {
    if (!bridge) {
      end('Source selection is unavailable. Close this window and try again.');
      cancel.focus();
      return;
    }
    const result = await bridge.getSources();
    if (ended) return;
    if (!result.ok) {
      end('Source selection ended. Close this window and try again.');
      cancel.focus();
      return;
    }
    snapshot = result.data;
    if (snapshot.sound !== undefined && !Object.hasOwn(soundLabels, snapshot.sound)) {
      end('This capture audio mode is unsupported. Close this window and try again.');
      return;
    }
    sound.hidden = snapshot.sound !== undefined;
    audioSummary.hidden = snapshot.sound === undefined;
    counts.window.textContent = String(
      snapshot.sources.filter((source) => source.kind === 'window').length,
    );
    counts.screen.textContent = String(
      snapshot.sources.filter((source) => source.kind === 'screen').length,
    );
    for (const source of snapshot.sources) {
      const item = document.createElement('li');
      item.dataset.kind = source.kind;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'source';
      button.setAttribute('aria-pressed', 'false');
      const preview = document.createElement('span');
      preview.className = 'source-preview';
      if (source.previewDataUrl) {
        const image = document.createElement('img');
        image.src = source.previewDataUrl;
        image.alt = '';
        preview.append(image);
      } else {
        preview.classList.add('is-empty');
        preview.textContent = source.kind === 'screen' ? '▤' : '▣';
      }
      const meta = document.createElement('span');
      meta.className = 'source-meta';
      const kindLabel = document.createElement('span');
      kindLabel.className = 'source-kind';
      kindLabel.textContent = source.kind === 'screen' ? 'Display' : 'Window';
      const label = document.createElement('span');
      label.className = 'source-label';
      label.textContent = source.label;
      button.title = source.label;
      meta.append(kindLabel, label);
      button.append(preview, meta);
      item.append(button);
      list.append(item);
      item.hidden = source.kind !== 'window';
      button.addEventListener('click', () => {
        selected = source;
        for (const other of list.querySelectorAll('button'))
          other.setAttribute('aria-pressed', String(other === button));
        selectedLabel.textContent = source.label;
        if (snapshot.sound) {
          message(
            source.sounds.includes(selectedSound())
              ? 'Confirm this source.'
              : 'This source cannot provide the required audio. Choose another source.',
          );
          update();
          return;
        }
        radios.forEach((r) => {
          r.checked = false;
        });
        sound.disabled = false;
        system.disabled = !source.sounds.includes('system');
        application.disabled = !source.sounds.includes('application');
        help.textContent = !application.disabled
          ? 'Application audio includes this app and its child processes, including its other windows.'
          : !system.disabled
            ? 'The stream includes system audio from other applications and excludes Rajcord.'
            : 'Requested audio is unavailable for this source. Choose a compatible source or prepare video only.';
        message('Choose sound, then confirm this source.');
        update();
      });
    }
    showKind('window');
    list.querySelector('li:not([hidden]) button')?.focus();
  };
  void load();
})();
