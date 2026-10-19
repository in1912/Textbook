<script setup>
// 设置 → HTTPS 证书（自签名）。与工作台的 SSL 面板功能对齐：
// 查看当前证书 / 生成新证书 / 下载 cert.pem·key.pem / 上传替换 / 重启服务生效。
// 只在独立端出现（工作台有自己的 SSL 面板）；证书存 <data>/ssl，重启后生效。
import { computed, onMounted, ref } from 'vue';
import { BASE_PREFIX, token } from '../api.js';

const st = ref({ configured: false, cert_file: {}, key_file: {} });
const msg = ref('');
const msgType = ref('ok');
const generating = ref(false);
const uploading = ref(false);
const restarting = ref(false);
const upCert = ref(null);
const upKey = ref(null);
const gen = ref({ cn: '', san: '', days: 820, org: '' });

function flash(text, type = 'ok') {
  msg.value = text;
  msgType.value = type;
  setTimeout(() => { msg.value = ''; }, 6000);
}

async function sslFetch(path, opts = {}) {
  const t = token();
  const url = BASE_PREFIX + '/api/admin/ssl' + path
    + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(t);
  const init = { ...opts, headers: { ...(opts.headers || {}) } };
  if (opts.body && typeof opts.body !== 'string') {
    init.body = JSON.stringify(opts.body);
    init.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, init);
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = new Error((data && (data.message || data.error)) || ('HTTP ' + res.status));
    e.status = res.status;
    throw e;
  }
  return data;
}

const daysClass = computed(() => {
  const d = st.value.days_left;
  if (d < 0 || d <= 7) return 'err';
  if (d <= (st.value.remind_days || 30)) return 'warn';
  return '';
});
const sanList = computed(() => String(st.value.san || '')
  .split(',')
  .map((s) => s.trim().replace(/^(DNS|IP Address|IP):/i, ''))
  .filter(Boolean));

async function load() {
  try { st.value = await sslFetch('/status'); }
  catch (e) { flash('读取证书状态失败：' + e.message, 'err'); }
}

onMounted(async () => {
  await load();
  // CN 预填当前访问的主机名；局域网 IP 访问时同时填进 SAN
  if (!gen.value.cn) {
    const h = location.hostname;
    gen.value.cn = h && h !== 'localhost' && h !== '127.0.0.1' ? h : '';
    if (h && /^\d+\.\d+\.\d+\.\d+$/.test(h)) gen.value.san = h;
  }
});

async function doGenerate() {
  if (!gen.value.cn.trim()) return flash('请填写通用名称（CN），一般填域名或主机名', 'err');
  if (!confirm(`生成新证书并替换当前文件？\nCN: ${gen.value.cn}\n有效期: ${gen.value.days} 天\n（旧证书自动备份；生成后需重启服务生效）`)) return;
  generating.value = true;
  try {
    const r = await sslFetch('/generate', {
      method: 'POST',
      body: {
        cn: gen.value.cn,
        org: gen.value.org,
        days: gen.value.days,
        san: gen.value.san.split(/[,，\s]+/).filter(Boolean),
      },
    });
    st.value = r.status || st.value;
    flash(`新证书已生成（${r.days} 天，覆盖：${[...(r.dns || []), ...(r.ips || [])].join('、')}）。请点「重启服务」生效`);
  } catch (e) {
    flash('生成失败：' + e.message, 'err');
  } finally {
    generating.value = false;
  }
}

async function doUpload() {
  const fc = upCert.value && upCert.value.files && upCert.value.files[0];
  const fk = upKey.value && upKey.value.files && upKey.value.files[0];
  if (!fc || !fk) return flash('请同时选择证书与私钥两个文件', 'err');
  if (!confirm('上传并替换当前证书？（服务端会校验证书与私钥配对；旧文件自动备份）')) return;
  uploading.value = true;
  try {
    const [cert, key] = await Promise.all([fc.text(), fk.text()]);
    const r = await sslFetch('/upload', { method: 'POST', body: { cert, key } });
    st.value = r.status || st.value;
    flash('证书已替换。请点「重启服务」生效');
  } catch (e) {
    flash('替换失败：' + e.message, 'err');
  } finally {
    uploading.value = false;
  }
}

// 下载走 ?token= 查询参数（与项目里其它文件下载同一条通道）
async function dl(path, name) {
  try {
    const t = token();
    const url = BASE_PREFIX + '/api/admin/ssl' + path + '?token=' + encodeURIComponent(t);
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch (e) {
    flash('下载失败：' + e.message, 'err');
  }
}

async function restart() {
  if (!confirm('重启服务以应用证书？\n服务会在 1~3 秒内重启，页面稍后自动刷新；本地直跑安装会自动拉起，手动启动的需人工重开。')) return;
  restarting.value = true;
  try {
    const r = await sslFetch('/restart', { method: 'POST' });
    if (r.restart === 'suppressed') {
      flash(r.note || '进程没有重启（调试模式），手动重启后新证书才生效', 'err');
      restarting.value = false;
      return;
    }
    flash('服务正在重启——稍等几秒后刷新页面', 'ok');
    setTimeout(() => location.reload(), 6000);
  } catch (e) {
    flash('重启请求失败：' + e.message, 'err');
    restarting.value = false;
  }
}

function fmt(iso) {
  return iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—';
}
function fmtSize(n) {
  return !n ? '' : n < 1024 ? n + 'B' : (n / 1024).toFixed(1) + 'KB';
}
</script>

<template>
  <div>
    <div v-if="msg" class="card" style="padding:10px 14px">
      <span :style="{ color: msgType === 'err' ? 'var(--danger)' : 'var(--accent)' }">{{ msg }}</span>
    </div>

    <!-- ============ 当前证书 ============ -->
    <div class="card">
      <h3>HTTPS 证书（当前签名）</h3>
      <template v-if="!st.configured">
        <div class="hint" style="margin-top:0">
          尚未配置证书——当前服务以纯 HTTP 模式运行。在下方「生成新证书」后重启服务，即可启用
          <b>同端口 HTTP/HTTPS 自适应</b>：同一个端口，http:// 和 https:// 都能访问。
        </div>
      </template>
      <template v-else-if="st.error">
        <div class="notice err">{{ st.error }}</div>
      </template>
      <template v-else>
        <div v-if="st.days_left < 0" class="notice err">
          证书已过期 {{ -st.days_left }} 天（{{ fmt(st.valid_to) }}）——浏览器可能已拦截访问，请立即在下方生成新证书并重启。
        </div>
        <div v-else-if="st.days_left <= 7" class="notice err">
          证书仅剩 {{ st.days_left }} 天（{{ fmt(st.valid_to) }} 到期），请尽快更换。
        </div>
        <div v-else-if="st.days_left <= st.remind_days" class="notice warn">
          证书还有 {{ st.days_left }} 天到期（{{ fmt(st.valid_to) }}），建议尽快更换。
        </div>
        <div v-else class="hint" style="margin-top:0">
          证书有效（剩余 {{ st.days_left }} 天）。到期前 {{ st.remind_days }} 天起本页会显示提醒（不会每天推送消息，需要时来看这里）。
        </div>

        <div v-if="st.pending_restart" class="notice" style="margin-top:8px;color:var(--accent)">
          证书文件已替换，但服务还在用启动时加载的旧证书——点下方「重启服务」后生效。
        </div>
        <div v-if="st.key_matches === false" class="notice err" style="margin-top:8px">
          证书与私钥不匹配！HTTPS 将无法启用，请重新生成或上传正确的一对文件。
        </div>

        <div class="kv"><span>签发对象</span><b>{{ st.subject || '—' }}</b></div>
        <div class="kv"><span>签发者</span><b>{{ st.issuer || '—' }}（自签名）</b></div>
        <div class="kv"><span>生效日期</span><b>{{ fmt(st.valid_from) }}</b></div>
        <div class="kv">
          <span>到期日期</span>
          <b>{{ fmt(st.valid_to) }}
            <span class="chip" :class="daysClass">{{ st.days_left >= 0 ? '剩 ' + st.days_left + ' 天' : '已过期' }}</span>
          </b>
        </div>
        <div class="kv"><span>下次更换</span><b>{{ fmt(st.renew_after) }}（建议在此日期后、到期前完成更换）</b></div>
        <div class="kv">
          <span>覆盖域名/IP</span>
          <b style="display:flex;flex-wrap:wrap;gap:4px">
            <span v-for="(s, i) in sanList" :key="i" class="chip">{{ s }}</span>
            <span v-if="!sanList.length" class="muted">（无 SAN，老证书）</span>
          </b>
        </div>
        <div class="kv">
          <span>密钥配对</span>
          <b>{{ st.key_matches === null ? '—（缺 key.pem）' : st.key_matches ? '✓ 匹配' : '✗ 不匹配' }}</b>
        </div>
        <div class="kv">
          <span>文件位置</span>
          <b style="font-size:12px;word-break:break-all">
            {{ st.dir }}<br>
            <span class="muted">
              cert.pem {{ fmtSize(st.cert_file.size) }} · {{ fmt(st.cert_file.mtime) }}
              key.pem {{ st.key_file.exists ? fmtSize(st.key_file.size) + ' · ' + fmt(st.key_file.mtime) : '（不存在）' }}
            </span>
          </b>
        </div>
      </template>

      <div class="row wrap" style="margin-top:12px;padding-top:10px;border-top:1px dashed var(--line)">
        <button class="btn small" :disabled="!st.configured" @click="dl('/file/cert', 'cert.pem')">下载证书 cert.pem</button>
        <button class="btn small" :disabled="!st.configured" @click="dl('/file/key', 'key.pem')">下载私钥 key.pem</button>
        <button class="btn small danger" :disabled="!st.has_pair || restarting" @click="restart">
          {{ restarting ? '重启中…' : '重启服务（应用证书）' }}
        </button>
      </div>
      <div class="hint">
        下载的 cert.pem 可分发到手机/电脑做信任导入；key.pem 是私钥请妥善保管，不要发给任何人。
        证书存放在数据目录的 ssl 子目录（Docker 即 <code>/data/ssl</code>），重建/升级容器都不会丢。
      </div>
    </div>

    <!-- ============ 生成新证书 ============ -->
    <div class="card">
      <h3>生成新证书（自助签发）</h3>
      <div class="hint" style="margin-top:0;margin-bottom:10px">
        在这里生成即可，无需 openssl 命令行。生成会<b>立即替换</b>当前证书文件（旧的自动备份到 ssl/backup-时间戳/），
        重启服务后生效。有效期上限 {{ st.max_days || 825 }} 天（Chrome/苹果对自签名证书的信任上限）。
      </div>
      <div class="grid2">
        <label class="field">通用名称 CN（主域名/主机名）
          <input v-model="gen.cn" type="text" placeholder="text.example.com" />
        </label>
        <label class="field">附加域名 / IP（逗号分隔，自动分类进 SAN）
          <input v-model="gen.san" type="text" :placeholder="'192.168.1.10, textbook.local'" />
        </label>
        <label class="field">有效天数（1-{{ st.max_days || 825 }}）
          <input v-model.number="gen.days" type="number" min="1" :max="st.max_days || 825" />
        </label>
        <label class="field">组织名（可选）
          <input v-model="gen.org" type="text" placeholder="Textbook" />
        </label>
      </div>
      <div class="hint">
        CN 会自动加入域名 SAN，并附赠 localhost / 127.0.0.1（本机 https 调试用）。
        局域网设备也要走 https 的话，把服务器的局域网 IP 填进附加列表。
      </div>
      <button class="btn primary" :disabled="generating" @click="doGenerate">
        {{ generating ? '生成中（约 2-5 秒）…' : '生成并替换证书' }}
      </button>
    </div>

    <!-- ============ 上传替换 ============ -->
    <div class="card">
      <h3>上传替换（外部生成的证书）</h3>
      <div class="hint" style="margin-top:0;margin-bottom:10px">
        已在别处（如 openssl / 路由器）生成过证书的话，直接上传那一对 PEM 文件。必须成对且公钥匹配，旧文件同样自动备份。
      </div>
      <div class="row wrap" style="gap:14px">
        <div class="row" style="gap:6px">
          <span class="muted" style="font-size:12.5px">证书</span>
          <input ref="upCert" type="file" accept=".pem,.crt,.cer" />
        </div>
        <div class="row" style="gap:6px">
          <span class="muted" style="font-size:12.5px">私钥</span>
          <input ref="upKey" type="file" accept=".pem,.key" />
        </div>
      </div>
      <button class="btn primary" style="margin-top:10px" :disabled="uploading" @click="doUpload">
        {{ uploading ? '上传中…' : '校验并替换' }}
      </button>
    </div>

    <!-- ============ 说明 ============ -->
    <div class="card">
      <h3>使用方法与原理说明</h3>
      <div class="doc">
        <b>为什么要用 HTTPS？</b>
        <p>① 传输加密：局域网 Wi-Fi 或公网上的账号密码、笔记内容不裸奔；② 浏览器硬性要求：剪贴板、摄像头等 API 只在 https（或 localhost）下可用；③ 某些内嵌/网关场景更稳定。</p>
        <b>SSL 应用原理</b>
        <p>浏览器与服务器握手时，服务器出示证书（含公钥）证明身份，双方协商出会话密钥加密后续流量。证书需要被设备的「受信任根」背书——正规网站由 CA 机构签发；<b>自签名证书是服务器自己签自己</b>，不在系统信任链里，所以首次访问会看到「不安全」告警，需要每台设备手动信任一次。</p>
        <b>文件放什么路径？</b>
        <p>证书与私钥固定放在<b>数据目录的 ssl 子目录</b>：<code>{{ st.dir }}</code>（Docker 部署即容器内 <code>/data/ssl</code>，对应宿主机映射的 <code>./data/ssl/</code>）。服务启动时检测到这对文件就自动启用「同端口 HTTP/HTTPS 自适应」——同一个端口，浏览器用 http:// 和 https:// 都能访问，老书签不受影响。替换证书后必须重启服务才生效。</p>
        <b>怎么使用（生成 → 重启 → 信任）？</b>
        <p>① 在上方填 CN 和要覆盖的域名/IP，点「生成并替换」；② 点「重启服务」；③ 用 https://你的域名 访问；④ 每台设备做一次信任：Windows 双击下载的 cert.pem → 安装证书 → 存储位置选「本地计算机」→「将所有的证书都放入下列存储」→ 浏览选「受信任的根证书颁发机构」；iPhone/Android 下载 cert.pem 后在设置里安装（iOS 装完还要到 设置→通用→关于本机→证书信任设置 打开完全信任）。</p>
        <b>适用什么场景？</b>
        <p>家庭/小团队自建系统：局域网 IP 直连（https://192.168.x.x:9621）、内网穿透域名。注意：① 有效期不能超过 825 天；② 内网穿透映射必须是 TCP 型（HTTP 型会拦截 TLS 握手）；③ 公网正式对外运营请改用 Let's Encrypt 等正规免费证书（需域名解析验证）；④ 证书是自签的，换新证书后已信任旧证书的设备需要重新导入一次。</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.kv {
  display: flex; gap: 10px; align-items: baseline;
  padding: 4px 0; border-bottom: 1px dashed var(--line); font-size: 13px;
}
.kv > span:first-child { width: 88px; flex-shrink: 0; color: var(--mut); }
.kv > b { min-width: 0; }
.chip.err { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, var(--bg2)); }
.chip.warn { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, var(--bg2)); }
.doc p { margin: 6px 0 12px; font-size: 13px; line-height: 1.7; }
.doc b { font-size: 13px; }
.doc code { background: var(--bg2); padding: 1px 6px; border-radius: 4px; font-size: 12px; word-break: break-all; }
</style>
