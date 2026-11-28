// Real (operating system) menus instead of Webamp's HTML ones, which are drawn
// inside the webview and so get cut off at the window's edges.
//
// Webamp still opens its own menu (main menu, right-click, EQ presets, playlist
// sort/misc, repeat/shuffle), hidden by the `native-menus` class. This module
// sees it appear, copies it item by item into a Tauri popup menu at the cursor,
// and clicks the matching HTML item when one is picked, so every Webamp action
// and our injected Output device submenu work unchanged. The hidden menu is
// then closed with the same document click Webamp uses for click-away.
import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu } from '@tauri-apps/api/menu';

type Item = MenuItem | CheckMenuItem | PredefinedMenuItem | Submenu;

const isMac = navigator.userAgent.includes('Mac');
/** Windows menus treat `&` as a mnemonic marker. */
const text = (s: string) => (isMac ? s : s.replaceAll('&', '&&'));

/** The visible text of an HTML menu item, without its submenu. */
function label(li: Element): string {
  return [...li.childNodes]
    .filter((n) => !(n instanceof HTMLUListElement))
    .map((n) => n.textContent ?? '')
    .join('')
    .trim();
}

async function build(ul: Element, pick: (li: HTMLElement) => void): Promise<Item[]> {
  const items: Item[] = [];
  for (const li of ul.children) {
    if (!(li instanceof HTMLLIElement)) continue;
    if (li.classList.contains('hr')) {
      if (items.length) items.push(await PredefinedMenuItem.new({ item: 'Separator' }));
      continue;
    }
    const sub = li.querySelector(':scope > ul');
    if (sub) {
      items.push(await Submenu.new({ text: text(label(li)), items: await build(sub, pick) }));
      continue;
    }
    // Webamp shows hotkeys (Alt+W, L, X...) in its menu only as an attribute;
    // Windows menus right-align whatever follows a tab.
    const hotkey = li.getAttribute('hotkey');
    const opts = {
      text: text(label(li)) + (hotkey && !isMac ? `\t${hotkey}` : ''),
      enabled: !li.classList.contains('wamptube-note'),
      action: () => pick(li),
    };
    items.push(li.classList.contains('checked')
      ? await CheckMenuItem.new({ ...opts, checked: true })
      : await MenuItem.new(opts));
  }
  return items;
}

async function show(ul: HTMLElement) {
  let picked: HTMLElement | null = null;
  const menu = await Menu.new({ items: await build(ul, (li) => { picked = li; }) });
  try {
    await menu.popup(); // at the cursor; resolves once the menu has closed
  } catch (e) {
    console.error('[menu] popup failed:', String(e));
  }
  // The pick arrives as an event, possibly just after popup() returns.
  for (let i = 0; i < 10 && !picked; i++) await new Promise((r) => setTimeout(r, 20));
  const li = picked as HTMLElement | null;
  if (li?.isConnected) {
    (li.querySelector(':scope > a') ?? li).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  } else if (ul.isConnected) {
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })); // click-away
  }
  void menu.close();
}

export function installNativeMenus() {
  document.documentElement.classList.add('native-menus');
  const seen = new WeakSet<Element>();
  new MutationObserver(() => {
    for (const ul of document.querySelectorAll<HTMLElement>('#webamp-context-menu ul.context-menu')) {
      if (seen.has(ul)) continue;
      seen.add(ul);
      // Let output.ts add its submenu (its observer runs on the same change).
      setTimeout(() => void show(ul), 0);
    }
  }).observe(document.body, { childList: true, subtree: true });
}
