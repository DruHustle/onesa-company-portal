import assert from 'node:assert/strict';
import {test} from 'node:test';
import vm from 'node:vm';
import {createInteractionRecorder, installAircraftInteractionObserver, recordSyntheticPageObservation} from '../scripts/drone-product-diagnostics.mjs';

const observation = (changes = {}) => ({kind: 'scroll', page_ms: 10, renderer_state: 'loading', details_open: false,
  canvas_count: 1, scroll_y: 100, box: [24, 1200, 342, 50], point: null, ...changes});
const plain = value => JSON.parse(JSON.stringify(value));

test('pre-command observations survive an absent later DOM read without waiting for it', () => {
  let now = 0;
  const recorder = createInteractionRecorder(() => now);
  now = 40; recorder.observe(observation());
  now = 50; recorder.beforeCommand();
  now = 60; recorder.observe(observation({kind: 'pointerdown', point: [120, 320]}));
  const retained = {interaction: recorder.snapshot(), geometry: null};
  assert.equal(retained.interaction.command_ms, 50);
  assert.equal(retained.interaction.before_command.observed_ms, 40);
  assert.equal(retained.interaction.before_command.kind, 'scroll');
  assert.equal(retained.interaction.events.at(-1).kind, 'pointerdown');
  assert.equal(retained.geometry, null);
  assert.deepEqual(createInteractionRecorder(() => 0).snapshot(), {command_ms: null, before_command: null, events: [], dropped: 0, rejected: 0});
});

test('fixed value schema rejects arbitrary text, fields, nonfinite and oversized numbers', () => {
  const recorder = createInteractionRecorder(() => 0);
  const bad = [null, [], observation({url: 'https://private.invalid/value'}), observation({kind: 'private text'}),
    observation({renderer_state: 'private text'}), observation({details_open: 'true'}), observation({page_ms: -1}),
    observation({page_ms: Infinity}), observation({scroll_y: NaN}), observation({canvas_count: 9}),
    observation({canvas_count: 1.5}), observation({box: [0, 0, -1, 50]}), observation({box: [0, 0, 1e6 + 1, 50]}),
    observation({box: [0, 0, 10]}), observation({point: ['private text', 0]})];
  for (const value of bad) recorder.observe(value);
  const state = recorder.snapshot();
  assert.equal(state.rejected, bad.length); assert.deepEqual(state.events, []);
  assert.equal(JSON.stringify(state).includes('private'), false);
});

test('records and pre-command snapshot own their data independently of callers', () => {
  const recorder = createInteractionRecorder(() => 0), value = observation({point: [1, 2]});
  recorder.observe(value); recorder.beforeCommand();
  value.box[0] = 99; value.point[0] = 99; value.kind = 'click';
  const first = recorder.snapshot(); first.events[0].box[0] = 88; first.before_command.point[0] = 88;
  const second = recorder.snapshot();
  assert.equal(second.events[0].kind, 'scroll'); assert.equal(second.events[0].box[0], 24);
  assert.equal(second.before_command.point[0], 1);
});

test('a burst retains only the latest 16 bounded records within the existing artifact byte limit', () => {
  let now = 0;
  const recorder = createInteractionRecorder(() => now);
  for (let i = 0; i < 1000; i++) {
    now += 1e6;
    recorder.observe(observation({kind: 'document_ready', renderer_state: 'unavailable', page_ms: 1e6,
      scroll_y: -1e6, box: [-999999.99, -999999.99, 999999.99, 999999.99], point: [-999999.99, 999999.99]}));
  }
  recorder.beforeCommand();
  const state = recorder.snapshot();
  assert.equal(state.events.length, 16); assert.equal(state.dropped, 984); assert.equal(state.command_ms, 1e6);
  const record = {schema_version: 2, state: 'DRONE_PRODUCT_INTERACTION_FAILED', locale: 'de', width: 1440, mode: 'light',
    phase: 'aircraft_details', browser_connected: true, page_closed: false, javascript_errors: 1e6, crashes: 1e6,
    models: Array.from({length: 12}, () => ({asset_id: 'nvidia-transfer-conveyor', terminal: 'failed', status: 599, failure_code: 'net::ERR_CONTENT_LENGTH_MISMATCH'})),
    interaction: state, geometry: {left: -999999.99, top: -999999.99, width: 999999.99, height: 999999.99,
      client_width: 999999.99, scroll_width: 999999.99, details_open: true, renderer_state: 'unavailable'}};
  assert.ok(Buffer.byteLength(JSON.stringify(record)) <= 8192);
});

test('the Node bridge accepts only its exact main page and clean local product routes', () => {
  const recorder = createInteractionRecorder(() => 0);
  let current = 'http://127.0.0.1:3348/en/products/onesa-drone';
  const frame = {url: () => current}, page = {mainFrame: () => frame}, source = {page, frame};
  recordSyntheticPageObservation(source, page, recorder, observation());
  current = 'http://127.0.0.1:3348/de/products/onesa-drone';
  recordSyntheticPageObservation(source, page, recorder, observation());
  for (current of ['http://127.0.0.1:3348/en/products/onesa-drone?token=private', 'http://127.0.0.1:3348/en/products/onesa-drone#private',
    'https://public.invalid/en/products/onesa-drone', 'http://127.0.0.1:3348/admin', 'not a URL']) {
    recordSyntheticPageObservation(source, page, recorder, observation());
  }
  current = 'http://127.0.0.1:3348/en/products/onesa-drone';
  recordSyntheticPageObservation({...source, page: {}}, page, recorder, observation());
  recordSyntheticPageObservation({...source, frame: {url: () => current}}, page, recorder, observation());
  recordSyntheticPageObservation({}, page, recorder, observation());
  assert.equal(recorder.snapshot().events.length, 2);
  assert.equal(JSON.stringify(recorder.snapshot()).includes('private'), false);
});

function fixture({origin = 'http://127.0.0.1:3348', pathname = '/de/products/onesa-drone', childFrame = false, query = '', delivery} = {}) {
  let now = 0, reads = 0, failGeometry = false;
  const reports = [], registrations = [], observers = [];
  class Element {closest(selector) {return selector === 'summary' ? this.summary : null;}}
  const details = {open: false}, summary = new Element(); summary.summary = summary;
  summary.parentElement = details;
  summary.getBoundingClientRect = () => {reads++; if (failGeometry) throw new Error('unavailable'); return {left: 24, top: 1200, width: 342, height: 50};};
  details.querySelector = selector => selector === ':scope > summary' ? summary : null;
  const svg = {closest: selector => selector === 'details' ? details : null};
  const gallery = {getAttribute: () => 'loading', querySelectorAll: () => [{}]};
  const events = () => {
    const entries = [];
    return {entries,
      addEventListener(name, callback, options) {const entry = {name, callback, options, removed: false}; entries.push(entry); registrations.push(entry);},
      removeEventListener(name, callback, options) {for (const entry of entries) if (entry.name === name && entry.callback === callback && entry.options === options) entry.removed = true;},
      dispatch(name, event = {}) {for (const entry of [...entries]) if (!entry.removed && entry.name === name) entry.callback({type: name, ...event});},
    };
  };
  const document = {...events(), readyState: 'complete', querySelector(selector) {
    return selector === 'main details svg[role="img"]' ? svg : selector === '#nvidia-environments' ? gallery : null;
  }};
  const window = {...events(), scrollY: 100, __onesaDroneProductObservation(value) {reports.push(plain(value)); return delivery?.(value);}};
  window.top = childFrame ? {} : window;
  class MutationObserver {
    constructor(callback) {this.callback = callback; this.disconnected = false; observers.push(this);}
    observe(target, options) {this.target = target; this.options = options;}
    disconnect() {this.disconnected = true;}
  }
  vm.runInNewContext(`(${installAircraftInteractionObserver.toString()})()`, {window, document, Element, MutationObserver,
    location: {origin, pathname, search: query, hash: ''}, performance: {now: () => now}});
  return {reports, registrations, observers, document, window, summary, details, Element,
    advance(ms) {now += ms;}, reads: () => reads, breakGeometry() {failGeometry = true;}};
}

test('serialized observer reads only its native summary and registers passive bounded observations', () => {
  const view = fixture();
  assert.equal(view.reports[0].kind, 'document_ready');
  assert.ok(view.registrations.every(entry => entry.options.capture === true && entry.options.passive === true));
  assert.equal(view.observers.length, 1);
  assert.deepEqual(plain(view.observers[0].options.attributeFilter), ['data-state']);
  view.advance(50); view.window.dispatch('scroll');
  view.document.dispatch('click', {target: new view.Element(), clientX: 5, clientY: 6});
  view.document.dispatch('pointerdown', {target: view.summary, clientX: 5, clientY: 6});
  view.details.open = true; view.document.dispatch('toggle', {target: view.details});
  assert.deepEqual(view.reports.map(item => item.kind), ['document_ready', 'scroll', 'pointerdown', 'toggle']);
  assert.deepEqual(view.reports[2].point, [5, 6]); assert.equal(view.reports[3].details_open, true);
});

test('scroll and gallery bursts have a time limit and a hard read budget separate from native input', () => {
  const view = fixture();
  for (let i = 0; i < 1000; i++) {view.window.dispatch('scroll'); view.observers[0].callback();}
  assert.equal(view.reads(), 1);
  for (let i = 0; i < 40; i++) {view.advance(50); view.window.dispatch('scroll'); view.observers[0].callback();}
  assert.equal(view.reads(), 16); assert.equal(view.observers[0].disconnected, true);
  for (let i = 0; i < 1000; i++) view.document.dispatch('click', {target: view.summary, clientX: 5, clientY: 6});
  assert.equal(view.reads(), 32); assert.equal(view.reports.length, 32);
  assert.ok(view.registrations.every(entry => entry.removed));
});

test('failed geometry attempts consume both budgets and unregister even when every read throws', () => {
  const view = fixture(); view.breakGeometry(); view.advance(50);
  for (let i = 0; i < 1000; i++) {view.window.dispatch('scroll'); view.observers[0].callback();}
  assert.equal(view.reads(), 2, 'a failed passive read still advances the time gate');
  for (let i = 0; i < 1000; i++) {view.advance(50); view.window.dispatch('scroll'); view.observers[0].callback();}
  assert.equal(view.reads(), 16); assert.equal(view.observers[0].disconnected, true);
  for (let i = 0; i < 1000; i++) view.document.dispatch('click', {target: view.summary, clientX: 5, clientY: 6});
  assert.equal(view.reads(), 32); assert.equal(view.reports.length, 1);
  assert.ok(view.registrations.every(entry => entry.removed));
});

test('foreign routes or child frames install nothing and optional observation failures do not escape', async () => {
  for (const config of [{origin: 'https://public.invalid'}, {pathname: '/admin'}, {childFrame: true}, {query: '?token=private'}]) {
    const view = fixture(config); assert.equal(view.registrations.length, 0); assert.equal(view.reads(), 0);
  }
  const failedDelivery = fixture({delivery: () => Promise.reject(new Error('unavailable'))});
  failedDelivery.document.dispatch('click', {target: failedDelivery.summary, clientX: 1, clientY: 2});
  await new Promise(resolve => setImmediate(resolve));
  const broken = fixture({delivery: () => {throw new Error('unavailable');}});
  broken.breakGeometry();
  assert.doesNotThrow(() => broken.document.dispatch('click', {target: broken.summary, clientX: 1, clientY: 2}));
});
