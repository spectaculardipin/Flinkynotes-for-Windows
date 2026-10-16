# Flinkynotes — Theme (Windows → Electron)

- **Palette (exact hex):** Lemon `#FCE795/#E0AD08/#3A3008`, Peach `#FBCFA6/#E2762A/#422413`, Rose `#FAC4D1/#DC4570/#40161F`, Lilac `#D9C7FA/#7C4DEE/#2A1B44`, Sky `#BEDDFA/#2280D6/#13293A`, Mint `#B4E8D0/#0E9B6E/#0F2E23`, Sand `#E3D3B4/#A37B3C/#372C18`, Slate `#CBD6E2/#4E6579/#1A242E`. `notesStore.js`, `deck.html`, `editor.html`, `styles.css` all use these — no 5-color subset.
- **Rest pill:** 12px wide, 7px pad, 7×14 dashes, 5px gap, `rgba(28,28,30,.88)`, max 14 + overflow dash.
- **Fan:** 30px tabs, 40px lap shingle, pitch 56–106 sized to longest title, 3° lean (`rotate(-3deg)` right edge), 28px plus disc, 45ms stagger BackEase entrance, preview 120ms reveal / instant swap, tab never grows on hover.
- **Menus/tooltips:** paper `#F51D1D21`, edge `#2EFFFFFF`, ink `#F0FFFFFF`, Segoe UI 12.5px, 9px radius, drop shadow 18/45%.
- **Editor:** paper background, ink text, Segoe Script/Hand body 20px, header 52px drag (buttons `no-drag` — Electron swallows clicks in drag regions), footer 56px, 7px scrollbar, 8-dot footer palette.
- **Home:** warm paper (`#f2efe6/#f7f4ec/#fff`), same switches/segments, health ring + week bars in theme neutrals.
