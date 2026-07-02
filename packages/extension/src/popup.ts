/** Popup UI — email/password login + connection status + wallet balance. Talks
 *  only to the service worker over a port; does no networking itself. */
import { PORT_NAME, type SwToUi } from './messages.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const loginView = $('loginView');
const accountView = $('accountView');
const emailInput = $<HTMLInputElement>('email');
const passwordInput = $<HTMLInputElement>('password');
const loginError = $('loginError');
const dot = $('dot');
const connText = $('connText');
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
    if (loggedIn) loginError.classList.add('hidden');
  } else if (msg.evt === 'AUTH_ERROR') {
    loginError.textContent = msg.message;
    loginError.classList.remove('hidden');
  } else if (msg.evt === 'SERVER' && msg.message.type === 'BALANCE_UPDATE') {
    // Wallet balance = total (only drops when you win), matching the website.
    settled.textContent = `$${msg.message.settled}`;
  }
});

function submitLogin(): void {
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  if (!email || !password) return;
  loginError.classList.add('hidden');
  port.postMessage({ cmd: 'EMAIL_LOGIN', email, password });
}

$('loginBtn').addEventListener('click', submitLogin);
passwordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitLogin(); });
$('logoutBtn').addEventListener('click', () => {
  settled.textContent = '—';
  port.postMessage({ cmd: 'LOGOUT' });
});
