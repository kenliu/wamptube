// Audio output device picker: an "Output device" submenu in Webamp's main
// (Winamp logo) menu. Playback moves with HTMLMediaElement.setSinkId.
//
// Chromium (WebView2) shows device names and ids only to a page holding
// microphone permission; src-tauri/src/audio_out.rs grants it at startup and
// nothing here ever records. WKWebView has no setSinkId, so macOS lists a
// single "This computer". The choice is kept by device name in localStorage
// and re-applied at launch and whenever devices come and go.
//
// Sonos rooms (sonosmedia.ts) follow, under a separator, on every platform,
// with a grey "Searching..." or "No Sonos rooms found" line while there are none,
// so the submenu is always there. Picking a room moves playback to it; the
// choice is not kept across launches.

export interface Room { name: string; ip: string }
/** Sonos hooks from sonosmedia.ts, passed in so this module imports no DOM code. */
export interface SonosHooks {
  rooms: () => Room[];
  /** The discovery in progress, if any. */
  searching: () => Promise<unknown> | null;
  current: () => Room | null;
  routeTo: (room: Room | null) => unknown;
}

export interface Output { id: string; label: string }
type DeviceLike = Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'label'>;

const KEY = 'wamptube.outputDevice'; // chosen device's label; absent = system default

/** Real output devices, without Chromium's "default" and "communications" aliases. */
export function realOutputs(devices: DeviceLike[]): Output[] {
  return devices
    .filter((d) => d.kind === 'audiooutput' && d.label && d.deviceId &&
      d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d) => ({ id: d.deviceId, label: d.label }));
}

/** Name of the system default device, from Chromium's "Default - <name>" alias. */
export function defaultOutputName(devices: DeviceLike[]): string {
  const d = devices.find((x) => x.kind === 'audiooutput' && x.deviceId === 'default');
  return d?.label.replace(/^Default - /, '') ?? '';
}

function savedLabel(): string {
  try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; }
}
function saveLabel(label: string) {
  try { if (label) localStorage.setItem(KEY, label); else localStorage.removeItem(KEY); } catch { /* not kept */ }
}

export function installOutputMenu(el: HTMLMediaElement, sonos: SonosHooks) {
  // Local devices need setSinkId (WebView2); WKWebView has a single "This computer".
  const canPick = 'setSinkId' in el && !!navigator.mediaDevices?.enumerateDevices;
  let outputs: Output[] = [];
  let defaultName = '';

  const apply = async () => {
    if (!canPick) return;
    const want = savedLabel();
    const id = outputs.find((o) => o.label === want)?.id ?? ''; // gone or unset: system default
    if (el.sinkId === id) return;
    try {
      await el.setSinkId(id);
      console.warn(`[audio] output: ${want && id ? want : `system default (${defaultName})`}`);
    } catch (e) {
      console.error('[audio] setSinkId failed', String(e));
    }
  };
  const refresh = async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    outputs = realOutputs(devices);
    defaultName = defaultOutputName(devices);
    await apply();
  };
  if (canPick) {
    void refresh();
    navigator.mediaDevices.addEventListener('devicechange', () => void refresh());
  }
  sonos.rooms(); // discover at launch so the first menu already lists them

  // Webamp renders a context menu into #webamp-context-menu only while it is open.
  // Add the submenu to the main menu (the one ending in "Exit"), above "Options".
  const addTo = (menu: Element) => {
    if (menu.querySelector(':scope > .wamptube-output')) return;
    const items = [...menu.children];
    const exit = items.find((li) => li.textContent === 'Exit');
    if (!exit) return;
    const room = sonos.current();
    const current = savedLabel();
    const sub = document.createElement('ul');
    const item = (text: string, checked: boolean, pick: () => void) => {
      const li = document.createElement('li');
      li.textContent = text;
      if (checked) li.classList.add('checked');
      li.addEventListener('click', pick); // Webamp closes the menu
      return li;
    };
    const local = (label: string, text: string) =>
      item(text, !room && (label === current || (!current && label === '')), () => {
        saveLabel(label);
        void apply();
        void sonos.routeTo(null);
      });
    if (canPick && outputs.length > 0) {
      sub.append(
        local('', defaultName ? `System default (${defaultName})` : 'System default'),
        ...outputs.map((o) => local(o.label, o.label)),
      );
    } else {
      sub.append(item('This computer', !room, () => void sonos.routeTo(null)));
    }
    const hr = document.createElement('li');
    hr.className = 'hr';
    hr.append(document.createElement('hr'));
    sub.append(hr);
    // The Sonos part, redrawn if a discovery finishes while the menu is open.
    let shown: Element[] = [];
    const showRooms = () => {
      const rooms = sonos.rooms(); // also starts a fresh discovery if the last is stale
      const busy = sonos.searching();
      shown.forEach((li) => li.remove());
      if (rooms.length > 0) {
        shown = rooms.map((r) => item(`Sonos: ${r.name}`, room?.ip === r.ip, () => void sonos.routeTo(r)));
      } else {
        const note = document.createElement('li');
        note.className = 'wamptube-note';
        note.textContent = busy ? 'Searching for Sonos…' : 'No Sonos rooms found';
        note.addEventListener('click', (e) => e.stopPropagation()); // keep the menu open
        shown = [note];
      }
      sub.append(...shown);
      void busy?.then(() => { if (sub.isConnected) showRooms(); });
    };
    showRooms();
    const parent = document.createElement('li');
    parent.className = 'parent wamptube-output';
    parent.append(sub, 'Output device');
    const options = items.find((li) => li.classList.contains('parent') && li.lastChild?.textContent === 'Options');
    menu.insertBefore(parent, options ?? exit);
  };
  new MutationObserver(() => {
    const host = document.getElementById('webamp-context-menu');
    host?.querySelectorAll('ul.context-menu').forEach(addTo);
  }).observe(document.body, { childList: true, subtree: true });
}
