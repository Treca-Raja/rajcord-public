(() => {
  const bridge = window.rajcordCapturePicker;
  const status = document.getElementById('status');
  const list = document.getElementById('sources');
  const sound = document.getElementById('sound');
  const system = document.getElementById('system-sound');
  const help = document.getElementById('sound-help');
  const confirm = document.getElementById('confirm');
  const cancel = document.getElementById('cancel');
  let snapshot,
    selected,
    busy = false,
    ended = false;
  const radios = [...document.querySelectorAll('input[name=sound]')];
  const message = (text) => {
    status.textContent = text;
  };
  const update = () => {
    confirm.disabled = ended || busy || !selected || !radios.some((r) => r.checked);
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
      sound: radios.find((r) => r.checked).value,
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
    for (const source of snapshot.sources) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'source';
      button.setAttribute('aria-pressed', 'false');
      const kind = document.createElement('span');
      kind.className = 'source-kind';
      kind.textContent = source.kind === 'screen' ? 'Display' : 'Window';
      const label = document.createElement('span');
      label.className = 'source-label';
      label.textContent = source.label;
      button.title = source.label;
      button.append(kind, label);
      item.append(button);
      list.append(item);
      button.addEventListener('click', () => {
        selected = source;
        for (const other of list.querySelectorAll('button'))
          other.setAttribute('aria-pressed', String(other === button));
        radios.forEach((r) => {
          r.checked = false;
        });
        sound.disabled = false;
        system.disabled = !source.sounds.includes('system');
        help.textContent = system.disabled
          ? 'System sound is unavailable for this source. Choose video only explicitly.'
          : 'System sound can include other applications and call playback. Check your audio routing.';
        message('Choose sound, then confirm this source.');
        update();
      });
    }
    message('Select one source.');
    list.querySelector('button')?.focus();
  };
  void load();
})();
