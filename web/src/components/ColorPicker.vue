<script setup>
import { computed } from 'vue';

const props = defineProps({
  modelValue: { type: String, default: '#e11d48' },
  alpha: { type: Number, default: 1 },
  width: { type: Number, default: 2 },
  showAlpha: { type: Boolean, default: true },
});
const emit = defineEmits(['update:modelValue', 'update:alpha']);

// Grid palette: the 10 hues x 3 tones plus neutrals. Kept explicit rather than
// generated so the common teaching colours (red/blue/pencil grey) are stable.
const GRID = [
  '#000000', '#374151', '#6b7280', '#9ca3af', '#d1d5db', '#7c2d12', '#991b1b', '#b91c1c', '#dc2626', '#e11d48',
  '#ea580c', '#f59e0b', '#eab308', '#84cc16', '#16a34a', '#10b981', '#0d9488', '#0891b2', '#0284c7', '#2563eb',
  '#4f46e5', '#7c3aed', '#9333ea', '#c026d3', '#db2777', '#f472b6', '#fda4af', '#fcd34d', '#bef264', '#a7f3d0',
];
const QUICK = ['#e11d48', '#2563eb', '#16a34a', '#f59e0b', '#9333ea', '#111827', '#fbbf24', '#38bdf8'];

function norm(hex) {
  const s = String(hex || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    return ('#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]).toLowerCase();
  }
  return '#e11d48';
}
const hex = computed(() => norm(props.modelValue));
const rgb = computed(() => {
  const h = hex.value;
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
});
function setRgb(i, v) {
  const c = rgb.value.slice();
  c[i] = Math.max(0, Math.min(255, Math.round(Number(v) || 0)));
  emit('update:modelValue', '#' + c.map((x) => x.toString(16).padStart(2, '0')).join(''));
}
function pick(c) { emit('update:modelValue', c); }
const previewStyle = computed(() => ({
  background: hex.value,
  opacity: String(props.alpha),
  height: Math.max(2, Math.min(18, props.width)) + 'px',
}));
</script>

<template>
  <div class="colorpicker" @mousedown.stop @pointerdown.stop>
    <div class="row" style="justify-content:space-between;margin-bottom:8px">
      <strong style="font-size:12.5px">画笔颜色</strong>
      <span class="muted mono" style="font-size:11.5px">{{ hex }}</span>
    </div>

    <div class="sw-grid">
      <button v-for="c in GRID" :key="c" :style="{ background: c }" :class="{ on: c === hex }"
              :title="c" @click="pick(c)" />
    </div>

    <div class="row" style="margin-top:9px;gap:8px">
      <input class="spectrum" type="color" :value="hex" @input="pick($event.target.value)"
             title="光谱拾色器" />
      <span class="grow" />
      <span class="muted" style="font-size:11.5px">常用</span>
      <button v-for="c in QUICK" :key="c" class="quick" :style="{ background: c }" :title="c" @click="pick(c)" />
    </div>

    <div class="sliders">
      <label><span style="color:#e05252">R</span>
        <input type="range" min="0" max="255" :value="rgb[0]" @input="setRgb(0, $event.target.value)" />
        <span class="mono">{{ rgb[0] }}</span></label>
      <label><span style="color:#3d9a5c">G</span>
        <input type="range" min="0" max="255" :value="rgb[1]" @input="setRgb(1, $event.target.value)" />
        <span class="mono">{{ rgb[1] }}</span></label>
      <label><span style="color:#3d76c9">B</span>
        <input type="range" min="0" max="255" :value="rgb[2]" @input="setRgb(2, $event.target.value)" />
        <span class="mono">{{ rgb[2] }}</span></label>
    </div>

    <div v-if="showAlpha" class="sliders">
      <label><span>透明</span>
        <input type="range" min="5" max="100" :value="Math.round(alpha * 100)"
               @input="$emit('update:alpha', Number($event.target.value) / 100)" />
        <span class="mono">{{ Math.round(alpha * 100) }}%</span></label>
    </div>

    <div class="preview-line">
      <span class="muted" style="font-size:11.5px">预览</span>
      <span class="line" :style="previewStyle" />
      <span class="grow" />
      <button class="btn small" @click="$emit('update:alpha', 1)">不透明</button>
    </div>
  </div>
</template>

<style scoped>
.quick { width: 16px; height: 16px; border-radius: 4px; border: 1px solid rgba(0,0,0,.15); padding: 0; }
.line { flex: 1; border-radius: 999px; min-width: 60px; }
</style>
