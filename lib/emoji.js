/*
 * RitPost — emoji picker (shared by the side panel and the photo editor)
 *
 *   RitEmoji.attach(button, { target: textareaOrInput | () => el, onPick(emoji) })
 *
 * Opens a popover with search, categories, recently used and a skin-tone choice. Without
 * onPick, the emoji is inserted at the cursor of the target and an "input" event is fired.
 */
(() => {
  if (window.RitEmoji) return;

  // "emoji keywords" — a trailing ~ marks emojis that take a skin tone.
  const DATA = [
    ['Smileys', '😀', `😀 grin happy smile|😃 happy smile|😄 laugh smile|😁 grin beam|😆 laugh|😅 sweat relief|🤣 rofl laugh floor|😂 joy tears laugh|🙂 smile|🙃 upside down|😉 wink|😊 blush smile|😇 angel innocent|🥰 love hearts|😍 heart eyes love|🤩 star struck wow|😘 kiss|😗 kiss|☺️ smile|😚 kiss|😙 kiss|🥲 tear smile|😋 yum tasty|😛 tongue|😜 wink tongue|🤪 crazy zany|😝 tongue|🤑 money|🤗 hug|🤭 oops giggle|🫢 gasp|🤫 shh quiet|🤔 think hmm|🫡 salute|🤐 zip|🤨 eyebrow|😐 neutral|😑 expressionless|😶 silent|😏 smirk|😒 unamused|🙄 eye roll|😬 grimace|😮‍💨 exhale|🤥 lie|😌 relieved|😔 pensive sad|😪 sleepy|🤤 drool|😴 sleep|😷 mask sick|🤒 sick|🤕 hurt|🤢 nausea|🤮 vomit|🥵 hot|🥶 cold|🥴 woozy|😵 dizzy|🤯 mind blown|🤠 cowboy|🥳 party celebrate|🥸 disguise|😎 cool sunglasses|🤓 nerd|🧐 monocle|😕 confused|🫤 meh|😟 worried|🙁 frown|☹️ frown|😮 wow open|😯 hushed|😲 astonished|😳 flushed|🥺 pleading please|🥹 holding tears|😦 frown|😧 anguish|😨 fear|😰 anxious|😥 sad relief|😢 cry|😭 sob cry|😱 scream|😖 confounded|😣 persevere|😞 disappointed|😓 sweat|😩 weary|😫 tired|🥱 yawn|😤 triumph huff|😡 angry rage|😠 angry|🤬 swear|😈 devil|👿 imp|💀 skull dead|☠️ skull crossbones|💩 poop|🤡 clown|👻 ghost|👽 alien|🤖 robot|😺 cat smile|😸 cat grin|😹 cat joy|😻 cat love|🙈 see no evil monkey|🙉 hear no evil|🙊 speak no evil`],
    ['People', '👍', `👋 wave hello~|🤚 hand~|🖐️ hand fingers~|✋ hand stop~|🖖 vulcan~|👌 ok~|🤌 pinched~|🤏 pinch small~|✌️ peace victory~|🤞 fingers crossed luck~|🫰 heart fingers~|🤟 love you~|🤘 rock~|🤙 call me~|👈 left point~|👉 right point~|👆 up point~|👇 down point~|☝️ point up~|🫵 you point~|👍 thumbs up like yes~|👎 thumbs down no~|✊ fist~|👊 punch~|🤛 fist~|🤜 fist~|👏 clap applause~|🙌 raise hands praise~|🫶 heart hands~|👐 open hands~|🤲 palms prayer~|🤝 handshake deal|🙏 pray thanks please amen~|✍️ write~|💅 nails~|🤳 selfie~|💪 strong muscle~|🦾 arm|🧠 brain|🫀 heart|👀 eyes look|👁️ eye|👅 tongue|👄 lips|👶 baby~|🧒 child~|👦 boy~|👧 girl~|🧑 person~|👨 man~|👩 woman~|🧓 older~|👴 old man~|👵 old woman~|🙍 frown~|🙎 pout~|🙅 no~|🙆 ok~|💁 tip~|🙋 raise hand~|🧏 deaf~|🙇 bow~|🤦 facepalm~|🤷 shrug~|👨‍🎓 graduate~|👩‍🎓 graduate~|👨‍🏫 teacher~|👩‍🏫 teacher~|👨‍💻 coder~|👩‍💻 coder~|👨‍🍳 chef~|👩‍🍳 chef~|👮 police~|👷 worker~|🤴 prince~|👸 princess~|👰 bride~|🤵 groom~|🤰 pregnant~|🎅 santa~|🦸 hero~|🧑‍🤝‍🧑 people together|👫 couple|👪 family|🗣️ speaking|👤 silhouette|👥 people|🏃 run~|🚶 walk~|💃 dance~|🕺 dance~|🧘 yoga~|🛌 sleep`],
    ['Hearts', '❤️', `❤️ red heart love|🧡 orange heart|💛 yellow heart|💚 green heart|💙 blue heart|💜 purple heart|🤎 brown heart|🖤 black heart|🤍 white heart|🩷 pink heart|🩵 light blue heart|💔 broken heart|❣️ heart exclamation|💕 two hearts|💞 revolving hearts|💓 beating heart|💗 growing heart|💖 sparkling heart|💘 cupid|💝 heart gift|💟 heart decoration|❤️‍🔥 heart fire|❤️‍🩹 mending heart|💋 kiss|💯 hundred perfect|💢 anger|💥 boom|💫 dizzy|💦 sweat drops|💨 dash|🕳️ hole|💬 speech|🗨️ speech|💭 thought|💤 zzz|✅ check yes done|☑️ check|✔️ check|❌ cross no|❎ cross|➕ plus|➖ minus|➗ divide|✖️ multiply|❓ question|❔ question|❗ exclamation|❕ exclamation|‼️ double exclamation|⁉️ interrobang|⚠️ warning|🚫 prohibited|⛔ no entry|🔞 18|📵 no phones|🆕 new|🆓 free|🆗 ok|🆙 up|🆒 cool|🔝 top|🔥 fire hot lit|⭐ star|🌟 glowing star|✨ sparkles|⚡ lightning|☀️ sun|🌈 rainbow|🎵 music note|🎶 music|♻️ recycle|🔴 red circle|🟠 orange circle|🟡 yellow circle|🟢 green circle|🔵 blue circle|🟣 purple circle|⚫ black circle|⚪ white circle|🔶 diamond|🔷 diamond|▶️ play|⏸️ pause|⏺️ record|⏩ fast forward|🔁 repeat|🔔 bell|📣 megaphone|📢 loudspeaker announcement|🔊 speaker|📍 pin location|📌 pushpin|🔗 link|🏁 finish|🚩 flag|🏳️ white flag|🏴 black flag`],
    ['Celebrate', '🎉', `🎉 party tada celebrate|🎊 confetti|🎈 balloon|🎂 birthday cake|🍰 cake|🧁 cupcake|🎁 gift present|🎀 ribbon|🎄 christmas tree|🎃 halloween pumpkin|🎆 fireworks|🎇 sparkler|🧨 firecracker|🪅 pinata|🪩 disco|🥂 cheers toast|🍾 champagne|🏆 trophy winner|🥇 gold medal first|🥈 silver|🥉 bronze|🏅 medal|🎖️ medal|🎗️ ribbon|🎟️ ticket|🎫 ticket|🎤 microphone sing|🎧 headphones|🎼 score|🎹 piano|🥁 drum|🎷 sax|🎺 trumpet|🎸 guitar|🎻 violin|🎬 movie clapper|🎥 camera film|📸 camera flash|📷 camera|📹 video|📺 tv|🎮 game|🎲 dice|🎯 target bullseye|🎨 art palette|🎭 theater|💒 wedding|💍 ring|💐 bouquet|👑 crown king|🎓 graduation|⛪ church|🕌 mosque|🕍 synagogue|✝️ cross|☪️ crescent|🕎 menorah|☮️ peace|🙏🏽 pray|🕊️ dove peace`],
    ['Nature', '🌸', `🐶 dog|🐱 cat|🐭 mouse|🐹 hamster|🐰 rabbit|🦊 fox|🐻 bear|🐼 panda|🐨 koala|🐯 tiger|🦁 lion|🐮 cow|🐷 pig|🐸 frog|🐵 monkey|🐔 chicken|🐧 penguin|🐦 bird|🐤 chick|🦆 duck|🦅 eagle|🦉 owl|🦇 bat|🐺 wolf|🐴 horse|🦄 unicorn|🐝 bee|🦋 butterfly|🐌 snail|🐞 ladybug|🐢 turtle|🐍 snake|🦖 dinosaur|🐙 octopus|🦀 crab|🐠 fish|🐬 dolphin|🐳 whale|🦈 shark|🐊 crocodile|🦓 zebra|🦒 giraffe|🐘 elephant|🦏 rhino|🐪 camel|🌵 cactus|🎄 tree|🌲 evergreen|🌳 tree|🌴 palm|🌱 seedling|🌿 herb|☘️ shamrock|🍀 clover luck|🍃 leaves|🍂 fallen leaf|🍁 maple|🌾 rice|🌺 hibiscus|🌻 sunflower|🌹 rose|🥀 wilted|🌷 tulip|🌼 blossom|🌸 cherry blossom|💐 bouquet|🍄 mushroom|🌍 earth africa|🌎 earth americas|🌏 earth asia|🌕 full moon|🌙 moon|⭐ star|☀️ sun|🌤️ sun cloud|⛅ cloud sun|🌧️ rain|⛈️ storm|❄️ snow|☃️ snowman|🌊 wave ocean|💧 drop water|🌪️ tornado|🌫️ fog`],
    ['Food', '🍔', `🍏 apple|🍎 red apple|🍐 pear|🍊 orange|🍋 lemon|🍌 banana|🍉 watermelon|🍇 grapes|🍓 strawberry|🫐 blueberries|🍈 melon|🍒 cherries|🍑 peach|🥭 mango|🍍 pineapple|🥥 coconut|🥝 kiwi|🍅 tomato|🥑 avocado|🍆 eggplant|🥔 potato|🥕 carrot|🌽 corn|🌶️ pepper hot|🥒 cucumber|🥬 greens|🥦 broccoli|🧄 garlic|🧅 onion|🥜 peanuts|🍞 bread|🥐 croissant|🥖 baguette|🥨 pretzel|🧀 cheese|🥚 egg|🍳 cooking|🥞 pancakes|🥓 bacon|🍗 chicken leg|🍖 meat|🌭 hot dog|🍔 burger|🍟 fries|🍕 pizza|🥪 sandwich|🌮 taco|🌯 burrito|🥗 salad|🍝 spaghetti|🍜 noodles|🍲 stew|🍛 curry|🍣 sushi|🍚 rice|🍤 shrimp|🍦 ice cream|🍩 doughnut|🍪 cookie|🍫 chocolate|🍬 candy|🍭 lollipop|🍯 honey|🥛 milk|☕ coffee|🍵 tea|🧃 juice|🥤 soda|🧋 bubble tea|🍺 beer|🍷 wine|🍸 cocktail|🍹 tropical drink|🥂 cheers|🍽️ plate|🍴 fork knife`],
    ['Activities', '⚽', `⚽ football soccer|🏀 basketball|🏈 american football|⚾ baseball|🎾 tennis|🏐 volleyball|🏉 rugby|🎱 pool|🏓 ping pong|🏸 badminton|🥊 boxing|🥋 martial arts|⛳ golf|🏹 archery|🎣 fishing|🤿 diving|🎽 running|🛹 skateboard|⛸️ skate|🎿 ski|🏂 snowboard~|🏋️ weights gym~|🤸 cartwheel~|⛹️ ball~|🏊 swim~|🚴 cycling~|🏇 horse race|🧗 climb~|🚗 car|🚕 taxi|🚌 bus|🏎️ race car|🚓 police car|🚑 ambulance|🚒 fire engine|🚚 truck|🚲 bicycle|🛵 scooter|🏍️ motorcycle|✈️ plane travel|🚀 rocket launch|🛸 ufo|🚁 helicopter|⛵ sailboat|🚢 ship|⚓ anchor|🚦 traffic light|🗺️ map|🗽 liberty|🗼 tower|🏰 castle|🏟️ stadium|🎡 ferris wheel|🎢 roller coaster|🏖️ beach|🏝️ island|🏜️ desert|⛰️ mountain|🏕️ camping|🏠 house home|🏡 home garden|🏢 office|🏥 hospital|🏦 bank|🏫 school|🏪 store|⛪ church|🌆 city|🌃 night|🌉 bridge`],
    ['Objects', '💡', `⌚ watch|📱 phone mobile|💻 laptop|⌨️ keyboard|🖥️ computer|🖨️ printer|🖱️ mouse|💾 disk|💿 cd|📀 dvd|☎️ telephone|📞 phone call|📟 pager|📠 fax|🔋 battery|🔌 plug|💡 idea bulb|🔦 flashlight|🕯️ candle|💸 money flying|💵 dollar|💶 euro|💷 pound|💰 money bag|💳 card|💎 gem diamond|⚖️ balance|🔧 wrench|🔨 hammer|⚙️ gear|🧲 magnet|🧪 test tube|🔬 microscope|🔭 telescope|💊 pill|💉 syringe|🩺 stethoscope|🚪 door|🛏️ bed|🛋️ couch|🚽 toilet|🚿 shower|🧴 lotion|🧹 broom|🧺 basket|🧻 paper|🧼 soap|🛒 cart shopping|🎒 backpack|👜 handbag|👛 purse|👓 glasses|🕶️ sunglasses|👔 shirt|👕 t-shirt|👖 jeans|👗 dress|👘 kimono|👠 heel|👟 sneaker|🧢 cap|🎩 top hat|💄 lipstick|📚 books|📖 book open bible|📝 memo note|✏️ pencil|🖊️ pen|📒 notebook|📅 calendar|📆 calendar|🗓️ calendar|📊 chart|📈 trending up growth|📉 trending down|📋 clipboard|📁 folder|📦 package box|✉️ envelope|📧 email|📨 incoming|📩 envelope arrow|📮 postbox|🔒 lock|🔓 unlock|🔑 key|🗝️ old key|⏰ alarm clock|⏳ hourglass|⌛ hourglass done|🕐 one oclock|🏷️ label tag|🔖 bookmark|🧾 receipt|📰 newspaper|🎙️ studio mic|📡 satellite|🛰️ satellite|🧭 compass|🧸 teddy bear|🪄 magic wand|🔮 crystal ball`],
    ['Flags', '🏳️', `🇬🇭 ghana|🇳🇬 nigeria|🇰🇪 kenya|🇿🇦 south africa|🇺🇬 uganda|🇹🇿 tanzania|🇨🇲 cameroon|🇨🇮 ivory coast|🇸🇳 senegal|🇪🇹 ethiopia|🇪🇬 egypt|🇲🇦 morocco|🇺🇸 usa united states|🇨🇦 canada|🇧🇷 brazil|🇲🇽 mexico|🇬🇧 uk united kingdom|🇮🇪 ireland|🇫🇷 france|🇩🇪 germany|🇮🇹 italy|🇪🇸 spain|🇵🇹 portugal|🇳🇱 netherlands|🇧🇪 belgium|🇨🇭 switzerland|🇸🇪 sweden|🇳🇴 norway|🇩🇰 denmark|🇵🇱 poland|🇺🇦 ukraine|🇹🇷 turkey|🇮🇱 israel|🇸🇦 saudi arabia|🇦🇪 uae emirates|🇮🇳 india|🇵🇰 pakistan|🇨🇳 china|🇯🇵 japan|🇰🇷 korea|🇵🇭 philippines|🇮🇩 indonesia|🇦🇺 australia|🇳🇿 new zealand|🇯🇲 jamaica|🇹🇹 trinidad|🏳️‍🌈 rainbow flag|🏴‍☠️ pirate|🇪🇺 european union|🇺🇳 united nations`],
  ];

  const CATS = DATA.map(([name, icon, raw]) => ({
    name,
    icon,
    items: raw.split('|').map((s) => {
      const sp = s.indexOf(' ');
      const e = sp < 0 ? s : s.slice(0, sp);
      let kw = sp < 0 ? '' : s.slice(sp + 1);
      const tone = kw.endsWith('~');
      if (tone) kw = kw.slice(0, -1);
      return { e, kw: `${name.toLowerCase()} ${kw}`.toLowerCase(), tone };
    }),
  }));
  const ALL = CATS.flatMap((c) => c.items);
  const TONES = ['', '\u{1F3FB}', '\u{1F3FC}', '\u{1F3FD}', '\u{1F3FE}', '\u{1F3FF}'];
  const TONE_SWATCH = ['#ffcc4d', '#f7dece', '#f3d2a2', '#d5ab88', '#af7e57', '#7c533e'];

  const store = {
    get(k, d) {
      try {
        const v = JSON.parse(localStorage.getItem(`ritpost-emoji-${k}`));
        return v ?? d;
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(`ritpost-emoji-${k}`, JSON.stringify(v));
      } catch {
        /* private window etc. */
      }
    },
  };

  /** Put a skin tone on an emoji that takes one (on its first code point). */
  function withTone(item, tone) {
    if (!item.tone || !tone) return item.e;
    const chars = [...item.e.replace(/️/g, '')];
    chars.splice(1, 0, TONES[tone]);
    return chars.join('');
  }

  /** Insert text at the cursor of a textarea/input and tell its listeners. */
  function insertAtCursor(el, text) {
    if (!el) return;
    el.focus();
    const s = el.selectionStart ?? el.value.length;
    const e = el.selectionEnd ?? el.value.length;
    el.setRangeText(text, s, e, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  let styled = false;
  function addStyle() {
    if (styled) return;
    styled = true;
    const st = document.createElement('style');
    st.textContent = `
.rp-emoji{position:fixed;z-index:1000;width:min(320px,calc(100vw - 16px));background:var(--bg,#fff);color:var(--ink,#0f172a);border:1px solid var(--line,#e2e8f0);border-radius:14px;box-shadow:0 18px 48px -12px rgba(15,23,42,.4);display:flex;flex-direction:column;overflow:hidden;font:13px/1.4 "Segoe UI",Roboto,sans-serif;animation:rpe-pop .12s ease-out}
@keyframes rpe-pop{from{opacity:0;transform:translateY(-4px)}}
.rp-emoji .rpe-top{display:flex;gap:6px;align-items:center;padding:8px 8px 6px}
.rp-emoji input{flex:1;min-width:0;height:30px;padding:0 10px;border:1px solid var(--line,#e2e8f0);border-radius:8px;background:var(--surface,#f8fafc);color:inherit;outline:none;font:inherit}
.rp-emoji input:focus{border-color:var(--brand-2,#14b88a)}
.rp-emoji .rpe-tones{display:flex;gap:2px}
.rp-emoji .rpe-tones button{width:16px;height:16px;border-radius:50%;border:2px solid transparent;padding:0;cursor:pointer}
.rp-emoji .rpe-tones button.on{border-color:var(--ink,#0f172a)}
.rp-emoji .rpe-cats{display:flex;gap:0;padding:0 4px;border-bottom:1px solid var(--line,#e2e8f0);overflow-x:auto;scrollbar-width:none}
.rp-emoji .rpe-cats button{flex:1;min-width:30px;height:30px;border:0;background:none;cursor:pointer;font-size:16px;border-bottom:2px solid transparent;opacity:.6;font-family:"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif}
.rp-emoji .rpe-cats button.on{opacity:1;border-bottom-color:var(--brand-2,#14b88a)}
.rp-emoji .rpe-grid{height:220px;overflow-y:auto;padding:4px 6px 8px}
.rp-emoji .rpe-h{font-size:11px;font-weight:700;color:var(--muted,#64748b);text-transform:uppercase;letter-spacing:.05em;padding:6px 4px 2px;position:sticky;top:-4px;background:var(--bg,#fff)}
.rp-emoji .rpe-row{display:grid;grid-template-columns:repeat(auto-fill,minmax(32px,1fr))}
.rp-emoji .rpe-row button{height:32px;border:0;background:none;border-radius:8px;cursor:pointer;font-size:21px;line-height:1;font-family:"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif}
.rp-emoji .rpe-row button:hover,.rp-emoji .rpe-row button:focus-visible{background:var(--soft,#f1f5f9);outline:none}
.rp-emoji .rpe-none{padding:24px;text-align:center;color:var(--muted,#64748b)}
.rp-emoji .rpe-foot{display:flex;justify-content:space-between;align-items:center;padding:6px 10px;border-top:1px solid var(--line,#e2e8f0);font-size:11.5px;color:var(--muted,#64748b);min-height:30px}
.rp-emoji .rpe-foot b{font-size:18px;margin-right:6px;font-weight:400}`;
    document.head.append(st);
  }

  let open = null;
  function close() {
    if (!open) return;
    open.el.remove();
    document.removeEventListener('mousedown', open.outside, true);
    document.removeEventListener('keydown', open.key, true);
    window.removeEventListener('resize', close);
    open.button?.setAttribute('aria-expanded', 'false');
    open = null;
  }

  function show(button, opts) {
    if (open?.button === button) return close();
    close();
    addStyle();
    let tone = store.get('tone', 0);
    let cat = -1; // -1 = all (with Recent on top)
    const el = document.createElement('div');
    el.className = 'rp-emoji';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Emoji');
    el.innerHTML = `<div class="rpe-top"><input type="search" placeholder="Search emoji (e.g. heart, party, pray)" aria-label="Search emoji"><div class="rpe-tones" title="Skin tone"></div></div><div class="rpe-cats"></div><div class="rpe-grid" tabindex="-1"></div><div class="rpe-foot"><span class="rpe-hover">Click to add · Shift+click to add several</span></div>`;
    const search = el.querySelector('input');
    const grid = el.querySelector('.rpe-grid');
    const cats = el.querySelector('.rpe-cats');
    const tones = el.querySelector('.rpe-tones');
    const foot = el.querySelector('.rpe-hover');

    const pick = (txt, keep) => {
      const recent = [txt, ...store.get('recent', []).filter((x) => x !== txt)].slice(0, 24);
      store.set('recent', recent);
      if (opts.onPick) opts.onPick(txt);
      else insertAtCursor(typeof opts.target === 'function' ? opts.target() : opts.target, txt);
      if (!keep) close();
      else render();
    };
    const btnFor = (item) => {
      const txt = typeof item === 'string' ? item : withTone(item, tone);
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = txt;
      b.title = typeof item === 'string' ? '' : item.kw.split(' ').slice(1, 4).join(' ');
      b.addEventListener('click', (e) => pick(txt, e.shiftKey));
      b.addEventListener('mouseenter', () => (foot.innerHTML = `<b>${txt}</b>${b.title || ''}`));
      return b;
    };
    const section = (title, items) => {
      const frag = document.createDocumentFragment();
      const hd = document.createElement('div');
      hd.className = 'rpe-h';
      hd.textContent = title;
      const row = document.createElement('div');
      row.className = 'rpe-row';
      items.forEach((i) => row.append(btnFor(i)));
      frag.append(hd, row);
      return frag;
    };
    function render() {
      const q = search.value.trim().toLowerCase();
      grid.replaceChildren();
      if (q) {
        const words = q.split(/\s+/);
        const hits = ALL.filter((i) => words.every((w) => i.kw.includes(w) || i.e === w));
        if (!hits.length) {
          const n = document.createElement('div');
          n.className = 'rpe-none';
          n.textContent = 'No emoji found';
          grid.append(n);
        } else grid.append(section(`Results (${hits.length})`, hits.slice(0, 120)));
        return;
      }
      const recent = store.get('recent', []);
      if (cat < 0) {
        if (recent.length) grid.append(section('Recently used', recent));
        CATS.forEach((c) => grid.append(section(c.name, c.items)));
      } else grid.append(section(CATS[cat].name, CATS[cat].items));
      grid.scrollTop = 0;
    }
    function renderCats() {
      cats.replaceChildren(
        ...[{ name: 'All', icon: '🕘' }, ...CATS].map((c, i) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = c.icon;
          b.title = i ? c.name : 'Recent and all';
          b.className = cat === i - 1 ? 'on' : '';
          b.addEventListener('click', () => {
            cat = i - 1;
            search.value = '';
            renderCats();
            render();
          });
          return b;
        })
      );
    }
    tones.replaceChildren(
      ...TONE_SWATCH.map((c, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.style.background = c;
        b.title = i ? `Skin tone ${i}` : 'Default skin tone';
        b.className = i === tone ? 'on' : '';
        b.addEventListener('click', () => {
          tone = i;
          store.set('tone', i);
          [...tones.children].forEach((x, j) => x.classList.toggle('on', j === i));
          render();
        });
        return b;
      })
    );
    search.addEventListener('input', render);
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        grid.querySelector('.rpe-row button')?.click();
      }
    });
    renderCats();
    render();
    document.body.append(el);

    // Position under (or above) the button, inside the window.
    const r = button.getBoundingClientRect();
    const w = el.offsetWidth;
    const hgt = el.offsetHeight;
    let left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
    if (opts.align === 'left') left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    let top = r.bottom + 6;
    if (top + hgt > window.innerHeight - 8) top = Math.max(8, r.top - hgt - 6);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    const outside = (e) => !el.contains(e.target) && !button.contains(e.target) && close();
    const key = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        close();
        button.focus();
      }
    };
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('resize', close);
    button.setAttribute('aria-expanded', 'true');
    open = { el, button, outside, key };
    setTimeout(() => search.focus(), 20);
  }

  function attach(button, opts = {}) {
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      show(button, opts);
    });
  }

  window.RitEmoji = { attach, close, insertAtCursor, all: ALL, categories: CATS };
})();
