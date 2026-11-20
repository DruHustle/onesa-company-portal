import { BillingClientError, blocksNewCheckout, createBillingClient, createCheckoutAttempt,
  operationStatus, trustedHostedUrl } from './client.mjs';
import { formatStripeMoney } from './money.mjs';

const POLLS = 30;
const POLL_INTERVAL = 2000;

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new BillingClientError('REQUEST_CANCELLED')); return; }
    const finish = () => { signal.removeEventListener('abort', cancel); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(new BillingClientError('REQUEST_CANCELLED')); };
    signal.addEventListener('abort', cancel, { once: true });
  });
}

function friendlyError(error) {
  if (error instanceof BillingClientError) {
    if (error.status === 401 || error.code === 'SESSION_REQUIRED') return 'Your session has ended. Sign in to Onesa again.';
    if (error.status === 403 || error.status === 404) return 'This billing account is not available to your current sign-in.';
    if (error.code === 'SALES_PAUSED') return 'Purchases are not available right now. Please check again later.';
    if (error.uncertain) return 'We could not confirm the last request. Check its status before starting another purchase.';
    if (['BILLING_CONFIGURATION_CHANGED', 'BILLING_REVISION_CONFLICT'].includes(error.code)) return 'Your billing account needs a fresh review. Refresh this page before continuing.';
  }
  return 'Billing is temporarily unavailable. Please try again.';
}

/** Mount beneath an already verified Onesa session. No sign-in, secret or role input is rendered here. */
export function mountBilling(element, { csrf, onSessionExpired, fetch: fetcher, navigate = url => window.location.assign(url) }) {
  if (!element || !element.ownerDocument || typeof csrf !== 'function' || typeof navigate !== 'function') {
    throw new BillingClientError('INVALID_MOUNT');
  }
  const document = element.ownerDocument;
  const client = createBillingClient({ csrf, ...(fetcher ? { fetch: fetcher } : {}) });
  const lifetime = new AbortController(), attempts = new Map();
  let accounts = [], offers = null, selected = '', operations = [], loaded = false, busy = false, destroyed = false;
  let notice = '', errorNotice = false, epoch = 0;
  const node = (tag, text, className) => {
    const result = document.createElement(tag);
    if (text !== undefined) result.textContent = text;
    if (className) result.className = className;
    return result;
  };
  const button = (text, action, disabled = false, primary = false) => {
    const result = node('button', text, primary ? 'onesa-billing-button onesa-billing-primary' : 'onesa-billing-button');
    result.type = 'button'; result.disabled = disabled;
    result.addEventListener('click', () => { void action(); });
    return result;
  };
  const announce = (text, isError = false) => { notice = text; errorNotice = isError; render(); };
  const fail = error => {
    if (destroyed || lifetime.signal.aborted) return;
    announce(friendlyError(error), true);
    if (error instanceof BillingClientError && (error.status === 401 || error.code === 'SESSION_REQUIRED')) onSessionExpired?.();
  };
  const currentAccount = () => accounts.find(account => account.id === selected);
  function replaceOperation(value) {
    operations = [value, ...operations.filter(item => item.id !== value.id)];
    const attempt = attempts.get(value.accountId);
    if (attempt?.snapshot().phase === 'checkout' && attempt.snapshot().operation?.id === value.id && !blocksNewCheckout(value)) {
      attempts.delete(value.accountId);
    }
  }
  async function guarded(action) {
    if (busy || destroyed) return;
    const restoreFocus = element.contains(document.activeElement);
    busy = true; notice = ''; errorNotice = false; render();
    try { await action(); } catch (error) { fail(error); }
    finally {
      busy = false; render();
      if (restoreFocus && !destroyed) {
        const feedback = element.querySelector(notice ? '[role=alert],[role=status]' : 'h1');
        if (feedback) { feedback.tabIndex = -1; feedback.focus({ preventScroll: true }); }
      }
    }
  }
  async function history(accountId = selected) {
    if (!accountId) { operations = []; return; }
    const expected = ++epoch;
    const values = await client.operations(accountId, lifetime.signal);
    if (destroyed || selected !== accountId || expected !== epoch) return;
    operations = [...values];
  }
  async function load() {
    const [nextCatalog, nextAccounts] = await Promise.all([client.catalog(lifetime.signal), client.accounts(lifetime.signal)]);
    if (destroyed) return;
    offers = nextCatalog; accounts = [...nextAccounts];
    if (!accounts.some(account => account.id === selected)) selected = accounts[0]?.id ?? '';
    await history(); loaded = true;
  }
  function open(operation) {
    const target = trustedHostedUrl(operation.redirectUrl, operation.kind);
    if (target) navigate(target);
  }
  async function drive(attempt, navigateWhenReady) {
    const deadline = AbortSignal.timeout(60_000), signal = AbortSignal.any([lifetime.signal, deadline]);
    try {
      for (let index = 0; index < POLLS && !destroyed; index++) {
        const state = await attempt.advance(signal), operation = state.operation;
        if (operation) replaceOperation(operation);
        if (operation?.reviewRequired || ['unknown', 'failed'].includes(operation?.state)) {
          announce('This request needs a billing review. Its status is saved; please do not start it again.');
          return;
        }
        if (state.phase === 'checkout' && operation?.state === 'succeeded') {
          if (operation.paymentConfirmed) announce('Payment confirmed.');
          else if (operation.redirectUrl) {
            announce('Your secure checkout is ready.');
            if (navigateWhenReady) open(operation);
          } else announce('We are waiting for payment confirmation. Refresh its status to check again.');
          return;
        }
        announce(state.phase === 'customer' ? 'Preparing your billing account…' : 'Preparing your secure checkout…');
        await wait(POLL_INTERVAL, signal);
      }
    } catch (error) {
      if (!deadline.aborted || lifetime.signal.aborted) throw error;
    }
    announce('Your request is still processing. Check its status to continue the same purchase.');
  }
  async function purchase(item, quantity) {
    await guarded(async () => {
      const account = currentAccount();
      if (!account || account.status !== 'active' || account.role === 'viewer' || !offers?.salesEnabled) return;
      await history(account.id);
      if (operations.some(blocksNewCheckout)) {
        announce('You already have a purchase awaiting a result. Continue or check it below.'); return;
      }
      let attempt = attempts.get(account.id);
      if (!attempt) {
        attempt = createCheckoutAttempt(client, account.id, [{ sku: item.sku, quantity }]);
        attempts.set(account.id, attempt);
      }
      await drive(attempt, true);
    });
  }
  async function check(operation, navigateWhenReady = false) {
    await guarded(async () => {
      const value = await client.operation(operation.id, selected, lifetime.signal);
      replaceOperation(value);
      if (value.paymentConfirmed) announce('Payment confirmed.');
      else if (value.reviewRequired) announce('This request needs a billing review. Its status is saved.');
      else if (navigateWhenReady && value.redirectUrl) open(value);
      else announce(operationStatus(value) + '.');
    });
  }
  function render() {
    if (destroyed) return;
    const shell = node('section', undefined, 'onesa-billing');
    shell.setAttribute('aria-label', 'Billing'); shell.setAttribute('aria-busy', String(busy));
    const header = node('header', undefined, 'onesa-billing-header');
    header.append(node('h1', 'Billing'), node('p', 'Your Onesa purchases and invoices.', 'onesa-billing-muted'));
    if (offers?.mode === 'test') header.append(node('p', 'Test environment — payments here do not charge a card.', 'onesa-billing-notice'));
    shell.append(header);
    const status = node('p', notice || (!loaded ? 'Loading your billing account…' : ''), 'onesa-billing-notice');
    status.setAttribute('role', errorNotice ? 'alert' : 'status'); status.setAttribute('aria-live', errorNotice ? 'assertive' : 'polite');
    if (!status.textContent) status.hidden = true;
    shell.append(status);
    if (!loaded) {
      if (!busy) shell.append(button('Try again', () => guarded(load)));
      element.replaceChildren(shell); return;
    }
    const toolbar = node('div', undefined, 'onesa-billing-toolbar');
    if (accounts.length) {
      const label = node('label', 'Billing account'), select = node('select');
      select.disabled = busy;
      for (const account of accounts) {
        const option = node('option', account.displayName); option.value = account.id; select.append(option);
      }
      select.value = selected;
      select.addEventListener('change', () => { selected = select.value; operations = []; void guarded(history); });
      label.append(select); toolbar.append(label);
    }
    toolbar.append(button('Refresh', () => guarded(load), busy)); shell.append(toolbar);
    if (!accounts.length) {
      const form = node('form', undefined, 'onesa-billing-card'), label = node('label', 'Account name'), input = node('input');
      input.name = 'displayName'; input.type = 'text'; input.required = true; input.maxLength = 200; input.autoComplete = 'organization';
      input.disabled = busy; label.append(input);
      const create = node('button', 'Create billing account', 'onesa-billing-button onesa-billing-primary');
      create.type = 'submit'; create.disabled = busy;
      form.append(node('h2', 'Set up your billing account'), node('p', 'Use the name you want to recognize on your Onesa billing page.'), label, create);
      form.addEventListener('submit', event => {
        event.preventDefault(); const name = input.value.trim();
        void guarded(async () => {
          try {
            const created = await client.createAccount(name, lifetime.signal); selected = created.id;
            await load(); announce('Your billing account is ready.');
          } catch (error) {
            // An uncertain account creation is resolved by listing accounts, not an automatic second POST.
            if (error instanceof BillingClientError && error.uncertain) await load();
            throw error;
          }
        });
      });
      shell.append(form); element.replaceChildren(shell); return;
    }
    const account = currentAccount(), attempt = attempts.get(selected);
    const pendingAttempt = attempt && !(attempt.snapshot().phase === 'checkout'
      && (attempt.snapshot().operation?.paymentConfirmed || attempt.snapshot().operation?.providerState?.startsWith('expired')));
    const hold = Boolean(pendingAttempt) || operations.some(blocksNewCheckout);
    if (account?.status !== 'active') shell.append(node('p', 'This billing account is currently unavailable for new purchases.', 'onesa-billing-notice'));
    if (!offers.salesEnabled) shell.append(node('p', 'Purchases are not available right now. Your existing billing records remain available.', 'onesa-billing-notice'));
    if (hold) {
      const pending = node('div', undefined, 'onesa-billing-notice');
      pending.append(node('p', 'A purchase is already awaiting a result. Continue that purchase or check its status below.'));
      if (attempt) pending.append(button('Check current purchase', () => guarded(() => drive(attempt, false)), busy));
      shell.append(pending);
    }
    const catalogSection = node('section'), grid = node('div', undefined, 'onesa-billing-grid');
    catalogSection.append(node('h2', 'Available purchases'));
    for (const item of offers.items) {
      const card = node('article', undefined, 'onesa-billing-card'), label = node('label', 'Quantity'), quantity = node('input');
      const price = formatStripeMoney(item.unitAmount, item.currency);
      quantity.type = 'number'; quantity.min = '1'; quantity.max = String(item.maxQuantity); quantity.step = '1'; quantity.value = '1';
      quantity.setAttribute('aria-label', 'Quantity for ' + item.title);
      quantity.disabled = busy || hold || !offers.salesEnabled || account?.role === 'viewer' || account?.status !== 'active' || price === null;
      label.append(quantity);
      const buy = button('Pay securely', async () => {
        const amount = Number(quantity.value);
        if (!quantity.reportValidity() || !Number.isSafeInteger(amount) || amount < 1 || amount > item.maxQuantity) return;
        await purchase(item, amount);
      }, quantity.disabled, true);
      card.append(node('h3', item.title), node('p', price ?? 'Price unavailable', 'onesa-billing-price'),
        node('p', item.taxBehavior === 'exclusive' ? 'Applicable tax is shown at checkout.' : 'The displayed price includes applicable tax.', 'onesa-billing-muted'), label, buy);
      grid.append(card);
    }
    if (!offers.items.length) grid.append(node('p', 'There are no purchases available yet.', 'onesa-billing-muted'));
    catalogSection.append(grid); shell.append(catalogSection);
    const historySection = node('section'), list = node('ul', undefined, 'onesa-billing-history');
    historySection.append(node('h2', 'Purchases and invoices'));
    const visible = operations.filter(item => ['checkout_create', 'invoice_create', 'invoice_finalize'].includes(item.kind));
    for (const operation of visible) {
      const row = node('li', undefined, 'onesa-billing-card'), text = node('div');
      text.append(node('h3', operation.kind === 'checkout_create' ? 'Purchase' : operation.kind === 'invoice_create' ? 'Invoice draft' : 'Invoice'),
        node('p', operationStatus(operation)));
      if (operation.amountMinor !== undefined && operation.currency) text.append(node('p', formatStripeMoney(operation.amountMinor, operation.currency) ?? 'Amount unavailable'));
      const actions = node('div', undefined, 'onesa-billing-actions');
      actions.append(button('Check status', () => check(operation), busy));
      if (!operation.reviewRequired && !operation.paymentConfirmed && operation.state === 'succeeded') {
        actions.append(button(operation.kind === 'checkout_create' ? 'Continue checkout' : 'View invoice', () => check(operation, true), busy));
      }
      row.append(text, actions); list.append(row);
    }
    if (!visible.length) historySection.append(node('p', 'Your purchases and invoices will appear here.', 'onesa-billing-muted'));
    else historySection.append(list);
    shell.append(historySection); element.replaceChildren(shell);
  }
  render(); void guarded(load);
  return Object.freeze({ destroy() { if (destroyed) return; destroyed = true; lifetime.abort(); attempts.clear(); element.replaceChildren(); } });
}
