<script setup>
// Monochrome line icons. Every icon is stroke=currentColor so day/night themes
// and disabled states come for free; no icon font, no coloured asset.
const props = defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 18 },
  stroke: { type: [Number, String], default: 1.7 },
});

const P = {
  menu: 'M3 6h18M3 12h18M3 18h18',
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-right': 'M9 6l6 6-6 6',
  'chevron-left': 'M15 6l-6 6 6 6',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  'folder-open': 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H3zM3 10h18l-2 7a2 2 0 0 1-2 1.6H5.6A2 2 0 0 1 3.7 17z',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  book: 'M4 5a2 2 0 0 1 2-2h6v18H6a2 2 0 0 1-2-2zM14 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4',
  'book-open': 'M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2zM22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z',
  pencil: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  pen: 'M20 4L9 15l-2 5 5-2L23 7zM14 6l4 4',
  marker: 'M9 11l-4 9 9-4M13 15l6-6a2 2 0 0 0 0-3l-3-3a2 2 0 0 0-3 0l-6 6z',
  highlighter: 'M4 20h6M8 16l8-8 4 4-8 8H8zM13 5l4 4',
  crayon: 'M6 20l-2 1 1-2 9-9 2 2zM14 4l6 6',
  eraser: 'M7 21h10M4 16l8-8 6 6-4 4H8z',
  line: 'M5 19L19 5',
  circle: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3',
  bookmark: 'M6 3h12v18l-6-4-6 4z',
  palette: 'M12 3a9 9 0 0 0 0 18h1.5a2 2 0 0 0 0-4H13a2 2 0 0 1 0-4h4a4 4 0 0 0 4-4c0-3.3-4-6-9-6z',
  image: 'M3 5h18v14H3zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 16l-5-5-9 8',
  share: 'M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.6 13.5l6.8 4M15.4 6.5l-6.8 4',
  download: 'M12 3v12M7 10l5 5 5-5M4 21h16',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  sparkles: 'M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.9 2.3L22 18l-2.1.8L19 21l-.9-2.2L16 18l2.1-.7zM5 16l.7 1.8L7.5 18.5l-1.8.7L5 21l-.7-1.8L2.5 18.5l1.8-.7z',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  x: 'M6 6l12 12M18 6L6 18',
  refresh: 'M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15M10 11v6M14 11v6',
  check: 'M4 12l5 5L20 6',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  lock: 'M6 11h12v10H6zM8 11V8a4 4 0 0 1 8 0v3',
  'panel-left': 'M3 4h18v16H3zM9 4v16',
  'panel-right': 'M3 4h18v16H3zM15 4v16',
  text: 'M5 4h14M12 4v16M9 20h6',
  quote: 'M7 7h4v6H5v-3a3 3 0 0 1 2-3zM17 7h3v6h-6v-3a3 3 0 0 1 3-3z',
  'arrow-left': 'M19 12H5M11 18l-6-6 6-6',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  expand: 'M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5',
  collapse: 'M3 8h5V3M21 8h-5V3M16 21v-5h5M8 21v-5H3',
};

const d = P[props.name] || P.file;
</script>

<template>
  <svg class="ic" :width="size" :height="size" viewBox="0 0 24 24" fill="none"
       :stroke-width="stroke" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"
       aria-hidden="true">
    <path :d="d" />
  </svg>
</template>

<style scoped>
.ic { display: block; flex-shrink: 0; }
</style>
