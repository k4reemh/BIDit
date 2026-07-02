/** Popup UI — login/account + connection status + balance. Talks only to the
 *  service worker over a port; does no networking itself. */
import { PORT_NAME, type SwToUi } from './messages.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const loginView = $('loginView');
const accountView = $('accountView');
const handleInput = $<HTMLInputElement>('handle');
const dot = $('dot');
const connText = $('connText');
const avail = $('avail');
const settled = $('settled');

const port = chrome.runtime.connect({ name: PORT_NAME });

port.onMessage.addListener((msg: SwToUi) => {
  if (msg.evt === 'STATUS') {
    const loggedIn = msg.handle !== null;
    loginView.classList.toggle('hidden', loggedIn);
    accountView.classList.toggle('hidden', !loggedIn);
    dot.className = `dot ${msg.connected ? 'on' : 'off'}`;
    connText.textContent = loggedIn
      ? `${msg.handle} · ${msg.connected ? 'connected' : 'connecting…'}`
      : 'not signed in';
  } else if (msg.evt === 'SERVER' && msg.message.type === 'BALANCE_UPDATE') {
    avail.textContent = `$${msg.message.available}`;
    settled.textContent = `$${msg.message.settled}`;
  }
});

$('loginBtn').addEventListener('click', () => {
  const handle = handleInput.value.trim();
  if (handle) port.postMessage({ cmd: 'LOGIN', handle });
});
$('logoutBtn').addEventListener('click', () => {
  avail.textContent = '—';
  settled.textContent = '—';
  port.postMessage({ cmd: 'LOGOUT' });
});
$('depositBtn').addEventListener('click', () => port.postMessage({ cmd: 'DEPOSIT', amount: '100' }));
