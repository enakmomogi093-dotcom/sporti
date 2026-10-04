// installpanel.js — fungsi inti instalasi Pterodactyl (Panel + Wings + Node) lewat SSH
const { Client } = require('ssh2');

const INSTALLER = `bash -c 'bash <(curl -fsSL https://pterodactyl-installer.se)'`;
const STAGE_TIMEOUT = 40 * 60 * 1000; // 40 menit per tahap
const DISK_MB = 51200;                // kapasitas disk node (ubah sesuai VPS)

/* ---------- Validasi input (cegah newline/karakter aneh masuk ke prompt & shell) ---------- */
const RX = {
  ip: /^(\d{1,3}\.){3}\d{1,3}$|^([a-z0-9-]+\.)+[a-z]{2,}$/i,
  domain: /^(?=.{4,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/i,
  user: /^[a-zA-Z0-9_]{3,20}$/,
  pass: /^[^\r\n\0]{8,64}$/,
  mail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
};
function validate(p) {
  if (!RX.ip.test(p.ipVps || '')) return 'IP VPS tidak valid';
  if (!RX.pass.test(p.pwVps || '')) return 'Password root tidak valid';
  if (!RX.domain.test(p.domainPanel || '')) return 'Domain panel tidak valid';
  if (!RX.domain.test(p.domainNode || '')) return 'Domain node tidak valid';
  if (!RX.user.test(p.usernamePanel || '')) return 'Username 3-20 karakter (huruf, angka, _)';
  if (!RX.pass.test(p.passwordPanel || '')) return 'Password panel 8-64 karakter';
  if (!RX.mail.test(p.gmailPanel || '')) return 'Email tidak valid';
  const ram = Number(p.ramServer);
  if (!Number.isInteger(ram) || ram < 512 || ram > 1048576) return 'RAM minimal 512 MB';
  return null;
}

/* ---------- Jalankan satu tahap + jawab prompt otomatis ---------- */
function runStage(ssh, cmd, rules, push) {
  return new Promise((resolve, reject) => {
    ssh.exec(cmd, { pty: true }, (err, stream) => {
      if (err) return reject(err);
      let buf = '', all = '';
      const done = new Set();
      const timer = setTimeout(() => { stream.close(); reject(new Error('Timeout: tahap terlalu lama')); }, STAGE_TIMEOUT);

      stream.on('data', (d) => {
        const s = d.toString().replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\r/g, '');
        s.split('\n').map(l => l.trim()).filter(Boolean).forEach(l => push('info', l));
        buf = (buf + s).slice(-1500);
        all = (all + s).slice(-20000);
        for (const r of rules) {
          if (r.once && done.has(r.re.source)) continue;
          if (r.re.test(buf)) {
            done.add(r.re.source);
            stream.write(r.reply);
            buf = '';              // kosongkan agar prompt yang sama tidak dijawab dua kali
            break;
          }
        }
      });
      stream.on('close', (code) => { clearTimeout(timer); resolve({ code, text: all }); });
    });
  });
}

/* ---------- Aturan jawaban prompt installer ---------- */
const panelRules = (p) => [
  { re: /Input 0-6/, reply: '0\n', once: true },
  { re: /Database name \(panel\)/, reply: '\n' },
  { re: /Database username \(pterodactyl\)/, reply: `${p.usernamePanel}\n` },
  { re: /Password \(press enter/, reply: `${p.passwordPanel}\n` },
  { re: /Select timezone/, reply: 'Asia/Jakarta\n' },
  { re: /Provide the email address/, reply: `${p.gmailPanel}\n` },
  { re: /Email address for the initial admin/, reply: `${p.gmailPanel}\n` },
  { re: /Username for the initial admin/, reply: `${p.usernamePanel}\n` },
  { re: /First name for the initial admin/, reply: `${p.usernamePanel}\n` },
  { re: /Last name for the initial admin/, reply: `${p.usernamePanel}\n` },
  { re: /Password for the initial admin/, reply: `${p.passwordPanel}\n` },
  { re: /Set the FQDN of this panel/, reply: `${p.domainPanel}\n` },
  { re: /Select the appropriate number/, reply: '1\n' },
  { re: /\(A\)gree\/\(C\)ancel/, reply: 'A\n' },
  { re: /\(yes\/no\)/, reply: 'y\n' },
  { re: /\(y\/N\)|\(Y\/n\)/, reply: 'y\n' }
];
const wingsRules = (p) => [
  { re: /Input 0-6/, reply: '1\n', once: true },
  { re: /Enter the panel address/, reply: `${p.domainPanel}\n`, once: true },
  { re: /Database host username/, reply: `${p.usernamePanel}\n`, once: true },
  { re: /Database host password/, reply: `${p.passwordPanel}\n`, once: true },
  { re: /Set the FQDN/, reply: `${p.domainNode}\n`, once: true },
  { re: /Enter email address for Let/, reply: `${p.gmailPanel}\n`, once: true },
  { re: /\(y\/N\)|\(Y\/n\)/, reply: 'y\n' }
];

/* ---------- Tahap 3: buat lokasi + node lewat artisan resmi, lalu pasang config Wings ---------- */
const nodeCmd = (p) => [
  'cd /var/www/pterodactyl',
  'php artisan p:location:make --short=id --long=Indonesia --no-interaction',
  `php artisan p:node:make --name=Node-1 --description=Auto --locationId=1 --fqdn=${p.domainNode} --public=1 --scheme=https --proxy=0 --maintenance=0 --maxMemory=${Number(p.ramServer)} --overallocateMemory=0 --maxDisk=${DISK_MB} --overallocateDisk=0 --uploadSize=100 --daemonListeningPort=8080 --daemonSFTPPort=2022 --daemonBase=/var/lib/pterodactyl/volumes --no-interaction`,
  'mkdir -p /etc/pterodactyl',
  'php artisan p:node:configuration 1 --format=yaml > /etc/pterodactyl/config.yml',
  'systemctl enable --now wings'
].join(' && ');

/* ---------- Tahap 4: buat Application API Key (ptla_) otomatis lewat service bawaan panel ---------- */
const keyCmd = () => `cd /var/www/pterodactyl && php artisan tinker --execute='$k = app(\\Pterodactyl\\Services\\Api\\KeyCreationService::class)->setKeyType(\\Pterodactyl\\Models\\ApiKey::TYPE_APPLICATION)->handle(["memo"=>"Auto Install","user_id"=>1,"r_allocations"=>3,"r_database_hosts"=>3,"r_eggs"=>3,"r_locations"=>3,"r_nests"=>3,"r_nodes"=>3,"r_server_databases"=>3,"r_servers"=>3,"r_users"=>3]); echo "KEY:".$k->identifier.decrypt($k->token);'`;
const KEY_RX = /ptla_[A-Za-z0-9]{48}/;

/* ---------- Fungsi utama ---------- */
function installPanel(p, onLog) {
  return new Promise((resolve, reject) => {
    const ssh = new Client();
    const secrets = [p.pwVps, p.passwordPanel];
    const push = (type, msg) => {
      let m = String(msg);
      secrets.forEach(s => { if (s) m = m.split(s).join('***'); }); // sembunyikan password dari log
      m = m.replace(/ptla_[A-Za-z0-9]{48}/g, 'ptla_***'); // key tidak ikut tercetak di log
      if (onLog) onLog(type, m);
    };
    const fail = (m) => { ssh.end(); reject(new Error(m)); };

    ssh.on('ready', async () => {
      try {
        push('info', '📦 Tahap 1: Instalasi Panel');
        let r = await runStage(ssh, INSTALLER, panelRules(p), push);
        if (r.code !== 0) return fail(`Panel gagal (code ${r.code})`);
        push('success', '✅ Tahap 1 selesai');

        push('info', '🔄 Tahap 2: Instalasi Wings');
        r = await runStage(ssh, INSTALLER, wingsRules(p), push);
        if (r.code !== 0) return fail(`Wings gagal (code ${r.code})`);
        push('success', '✅ Tahap 2 selesai');

        push('info', '📦 Tahap 3: Membuat Node');
        r = await runStage(ssh, nodeCmd(p), [], push);
        if (r.code !== 0) return fail(`Pembuatan node gagal (code ${r.code})`);
        push('success', '✅ Tahap 3 selesai');

        push('info', '🔑 Tahap 4: Membuat API Key (ptla)');
        r = await runStage(ssh, keyCmd(), [], push);
        const km = r.text.match(KEY_RX);
        if (km) push('success', '✅ API Key dibuat (tampil di hasil akhir)');
        else push('warning', '⚠️ API Key gagal dibuat otomatis. Buat manual: Admin → Application API');

        ssh.end();
        resolve({
          message: 'Install Panel Berhasil!',
          data: { domain_panel: p.domainPanel, domain_node: p.domainNode, username: p.usernamePanel, email: p.gmailPanel, api_key: km ? km[0] : null }
        });
      } catch (e) { fail(e.message); }
    });
    ssh.on('error', (e) => fail('SSH: ' + e.message));
    ssh.connect({ host: p.ipVps, port: 22, username: 'root', password: p.pwVps, readyTimeout: 20000, keepaliveInterval: 15000 });
  });
}

module.exports = { installPanel, validate };
