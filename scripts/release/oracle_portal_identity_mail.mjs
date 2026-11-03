// Read-only, bounded inbox observations. SMTP/provider acceptance is not delivery.
import tls from 'node:tls';
import {isIP} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';

export class MailObservationError extends Error {
  constructor(code) { super(code); this.name = 'MailObservationError'; }
}
const require = (value, code) => { if (!value) throw new MailObservationError(code); };
const MAX_MESSAGE = 65536;
const MAX_RESPONSE = 1024 * 1024;
const address = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9.-]{3,189}$/;
const quote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';

export function validateMailbox(value) {
  require(value && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).sort().join(',') === 'host,password,port,username', 'MAILBOX_SCHEMA');
  require(typeof value.host === 'string' && value.host.length <= 253 &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value.host) && value.host.includes('.') &&
    !isIP(value.host) && !/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(value.host) &&
    !value.host.includes('..') && value.port === 993, 'MAILBOX_TLS_TARGET');
  require(typeof value.username === 'string' && address.test(value.username) &&
    typeof value.password === 'string' && value.password.length >= 12 && value.password.length <= 512 &&
    !/[\x00-\x1f\x7f]/.test(value.password), 'MAILBOX_CREDENTIAL_SCHEMA');
  return value;
}

// Parse complete protocol records and literal byte counts before recognizing a
// tagged completion. A message containing a forged "A0001 OK" is only message data.
export function parseImapResponse(buffer, tag) {
  require(Buffer.isBuffer(buffer) && buffer.length <= MAX_RESPONSE &&
    (tag === null || /^A[0-9]{4}$/.test(tag)), 'IMAP_RESPONSE_BOUNDS');
  const records = [], literals = [];
  let offset = 0;
  while (offset < buffer.length) {
    const end = buffer.indexOf('\r\n', offset);
    if (end < 0) return null;
    const line = buffer.subarray(offset, end).toString('ascii');
    require(line.length <= 16384, 'IMAP_LINE_BOUNDS');
    records.push(line); offset = end + 2;
    const literal = /\{([0-9]+)\}$/.exec(line);
    if (literal) {
      const length = Number(literal[1]);
      require(Number.isSafeInteger(length) && length <= MAX_MESSAGE + 1, 'IMAP_LITERAL_BOUNDS');
      if (buffer.length - offset < length) return null;
      literals.push(buffer.subarray(offset, offset + length)); offset += length;
      continue;
    }
    if (tag === null && /^\* (?:OK|PREAUTH|BYE)\b/.test(line))
      return {records, literals, consumed: offset, ok: line.startsWith('* OK ')};
    if (tag && line.startsWith(tag + ' '))
      return {records, literals, consumed: offset, ok: line.startsWith(tag + ' OK ')};
  }
  return null;
}

class Inbox {
  constructor(socket) {
    this.socket = socket; this.iterator = socket[Symbol.asyncIterator]();
    this.pending = Buffer.alloc(0); this.sequence = 0;
  }
  async receive(tag) {
    for (;;) {
      const parsed = parseImapResponse(this.pending, tag);
      if (parsed) {
        this.pending = this.pending.subarray(parsed.consumed);
        require(parsed.ok, 'IMAP_COMMAND_REFUSED'); return parsed;
      }
      const next = await this.iterator.next();
      require(!next.done, 'IMAP_CONNECTION_ENDED');
      this.pending = Buffer.concat([this.pending, next.value]);
      require(this.pending.length <= MAX_RESPONSE, 'IMAP_RESPONSE_BOUNDS');
    }
  }
  async command(command) {
    require(!/[\r\n]/.test(command) && command.length < 2048 && this.sequence < 9999, 'IMAP_COMMAND_SCHEMA');
    const tag = 'A' + String(++this.sequence).padStart(4, '0');
    this.socket.write(tag + ' ' + command + '\r\n');
    return this.receive(tag);
  }
}

function decodeQuotedPrintable(body) {
  return body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

export function messageLink(raw, {recipient, after, portal, path}) {
  require(Buffer.isBuffer(raw) && raw.length <= MAX_MESSAGE && address.test(recipient), 'MAIL_MESSAGE_BOUNDS');
  require(['/account/confirm', '/account/security'].includes(path), 'MAIL_LINK_PATH');
  const text = raw.toString('utf8'), split = text.indexOf('\r\n\r\n');
  if (split < 0) return null;
  const header = text.slice(0, split).replace(/\r\n[ \t]+/g, ' ');
  const to = /^To:\s*(.*)$/im.exec(header)?.[1] || '';
  const recipients = to.match(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+/g) || [];
  if (!recipients.some(value => value.toLowerCase() === recipient.toLowerCase())) return null;
  const date = Date.parse(/^Date:\s*(.*)$/im.exec(header)?.[1] || '');
  if (!Number.isFinite(date) || date < after - 30000 || date > Date.now() + 30000) return null;
  // The application emits a text part. Decode MIME transfer encodings without
  // executing HTML, loading images, or following any message-supplied URL.
  const parts = text.split(/\r\n--[^\r\n]+\r\n/);
  const decoded = [text];
  for (const part of parts) {
    const boundary = part.indexOf('\r\n\r\n');
    if (boundary >= 0 && /Content-Transfer-Encoding:\s*quoted-printable/i.test(part.slice(0, boundary)))
      decoded.push(decodeQuotedPrintable(part.slice(boundary + 4)));
    if (boundary >= 0 && /Content-Transfer-Encoding:\s*base64/i.test(part.slice(0, boundary))) {
      const encoded = part.slice(boundary + 4).split(/\r\n--/)[0].replace(/\s/g, '');
      if (/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) decoded.push(Buffer.from(encoded, 'base64').toString('utf8'));
    }
  }
  const matches = new Set();
  for (const value of decoded) for (const candidate of value.match(/https:\/\/[^\s<>"']+/g) || []) {
    let url; try { url = new URL(candidate.replace(/&amp;/g, '&')); } catch { continue; }
    if (url.origin === portal && url.pathname === path && !url.search && !url.username && !url.password &&
      /^#access-link=[a-f0-9]{64}$/.test(url.hash)) matches.add(url.href);
  }
  require(matches.size <= 1, 'AMBIGUOUS_MAIL_LINK');
  return [...matches][0] || null;
}

export function deliveredLink(response, uid, observation) {
  require(response.literals.length === 1, 'IMAP_MESSAGE_LITERAL');
  const header = response.records.find(row => /^\* [0-9]+ FETCH \(/.test(row));
  require(header && new RegExp('(?:^|[ (])UID ' + uid + '(?: |\\))').test(header), 'IMAP_MESSAGE_IDENTITY');
  const size = Number(/RFC822\.SIZE ([0-9]+)/.exec(header)?.[1]);
  require(Number.isSafeInteger(size) && size > 0 && size <= MAX_MESSAGE &&
    response.literals[0].length === size, 'MAIL_MESSAGE_BOUNDS');
  const delivered = Date.parse(/INTERNALDATE "([^"]+)"/.exec(header)?.[1] || '');
  if (!Number.isFinite(delivered) || delivered < observation.after - 30000 || delivered > Date.now() + 30000) return null;
  return messageLink(response.literals[0], observation);
}

export async function waitForDeliveredLink(configuration, observation) {
  const mailbox = validateMailbox(configuration);
  require(address.test(observation.recipient) && Number.isFinite(observation.after) &&
    observation.after >= Date.now() - 60000 && observation.after <= Date.now(), 'MAIL_OBSERVATION_WINDOW');
  let socket;
  try {
    socket = tls.connect({host: mailbox.host, port: mailbox.port, servername: mailbox.host,
      rejectUnauthorized: true, minVersion: 'TLSv1.2'});
    socket.setTimeout(15000, () => socket.destroy(new MailObservationError('MAILBOX_TIMEOUT')));
    await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
    require(socket.authorized, 'MAILBOX_TLS_VERIFICATION');
    const inbox = new Inbox(socket);
    await inbox.receive(null);
    await inbox.command('LOGIN ' + quote(mailbox.username) + ' ' + quote(mailbox.password));
    await inbox.command('EXAMINE "INBOX"'); // Read-only selection; never mark, delete or move mail.
    const date = new Date(observation.after - 30000);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const since = String(date.getUTCDate()).padStart(2, '0') + '-' + months[date.getUTCMonth()] + '-' + date.getUTCFullYear();
    const seen = new Set(), deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const search = await inbox.command('UID SEARCH SINCE ' + quote(since) + ' TO ' + quote(observation.recipient));
      const line = search.records.find(value => /^\* SEARCH(?: |$)/.test(value));
      require(line !== undefined && /^\* SEARCH(?: [1-9][0-9]*)*$/.test(line), 'IMAP_SEARCH_SCHEMA');
      const ids = line.slice(8).trim().split(' ').filter(Boolean);
      require(ids.length <= 1000, 'MAIL_SEARCH_BOUNDS');
      for (const uid of ids.slice(-50)) {
        if (seen.has(uid)) continue;
        const response = await inbox.command('UID FETCH ' + uid + ' (UID RFC822.SIZE INTERNALDATE BODY.PEEK[]<0.65537>)');
        seen.add(uid);
        const link = deliveredLink(response, uid, observation);
        if (link) return link;
      }
      await delay(Math.min(3000, Math.max(0, deadline - Date.now())));
    }
    throw new MailObservationError('INBOX_DELIVERY_NOT_OBSERVED');
  } catch (error) {
    if (error instanceof MailObservationError) throw error;
    throw new MailObservationError('MAILBOX_OBSERVATION_FAILED');
  } finally { socket?.destroy(); }
}
