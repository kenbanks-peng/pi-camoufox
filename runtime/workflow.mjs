import { createHash } from 'node:crypto';

export const LIMITS = Object.freeze({ bytes: 65536, steps: 100, stepMs: 10000, overallMs: 120000, cleanupMs: 5000 });
function invalid() { throw Error('invalid-workflow'); }
export function fields(o, required, optional = []) {
  if (!o || typeof o !== 'object' || Array.isArray(o) || required.some(k => !(k in o)) || Object.keys(o).some(k => !required.includes(k) && !optional.includes(k))) invalid();
}
function str(v) { if (typeof v !== 'string' || !v.length || v.length > 8192) invalid(); }
function budget(v, max) { if (!Number.isInteger(v) || v < 1 || v > max) invalid(); }
export function validateTarget(t) {
  fields(t, [], ['role', 'name', 'label', 'testId', 'css']);
  if (['role','label','testId','css'].filter(k => k in t).length !== 1 || ('name' in t && !('role' in t))) invalid();
  Object.values(t).forEach(str);
}
export function validateWorkflow(w) {
  if (Buffer.byteLength(JSON.stringify(w)) > LIMITS.bytes) invalid();
  fields(w, ['version','start','steps'], ['stepMs','overallMs','artifacts']);
  if (w.version !== 1) invalid();
  fields(w.start, ['mode'], ['profile']);
  if (!['fresh','persistent'].includes(w.start.mode)) invalid();
  if (w.start.mode === 'persistent') { str(w.start.profile); if (!w.start.profile.startsWith('/')) invalid(); }
  else if ('profile' in w.start) invalid();
  if (w.stepMs !== undefined) budget(w.stepMs,30000);
  if (w.overallMs !== undefined) budget(w.overallMs,300000);
  if (w.artifacts !== undefined) { fields(w.artifacts, [], ['screenshot','trace']); Object.values(w.artifacts).forEach(v => { if (typeof v !== 'boolean') invalid(); }); }
  if (!Array.isArray(w.steps) || !w.steps.length || w.steps.length > LIMITS.steps) invalid();
  for (const s of w.steps) {
    if (s.action === 'goto') { fields(s,['action','url']); str(s.url); if (!['http:','https:'].includes(new URL(s.url).protocol)) invalid(); }
    else if (s.action === 'fill') { fields(s,['action','target','value']); validateTarget(s.target); if (typeof s.value !== 'string' || s.value.length > 8192) invalid(); }
    else if (s.action === 'click') { fields(s,['action','target']); validateTarget(s.target); }
    else if (s.action === 'expect') {
      fields(s,['action','kind','value'],['target']);
      if (s.kind === 'url') { if ('target' in s) invalid(); str(s.value); }
      else {
        validateTarget(s.target);
        if (s.kind === 'text') str(s.value);
        else if (['visible','enabled','checked'].includes(s.kind)) { if (typeof s.value !== 'boolean') invalid(); }
        else invalid();
      }
    } else invalid();
  }
  return w;
}
export function identity(w) {
  const safe = structuredClone(w);
  for (const s of safe.steps) if (s.action === 'fill') s.value = null;
  return createHash('sha256').update(JSON.stringify(safe)).digest('hex');
}
export function locator(page,t) {
  if (t.role) return page.getByRole(t.role,{name:t.name,exact:true});
  if (t.label) return page.getByLabel(t.label,{exact:true});
  if (t.testId) return page.getByTestId(t.testId);
  return page.locator(t.css);
}
export async function executeStep(page,s,timeout) {
  if (s.action === 'goto') return page.goto(s.url,{timeout,waitUntil:'domcontentloaded'});
  const end = Date.now()+timeout;
  if (s.kind === 'url') return page.waitForURL(url => url.href === s.value,{timeout});
  const l = locator(page,s.target);
  // Locator actions provide Playwright strict cardinality and actionability waits.
  if (s.action === 'fill') return l.fill(s.value,{timeout});
  if (s.action === 'click') return l.click({timeout});
  // Poll assertions with bounded Playwright waits, never retry actions.
  while (true) {
    const n = await l.count();
    if (n > 1) throw Error('ambiguity');
    if (n === 0 && s.kind === 'visible' && s.value === false) return;
    if (n === 1) {
      let actual;
      if (s.kind === 'text') actual = (await l.innerText({timeout: Math.max(1,end-Date.now())})).replace(/\s+/g,' ').trim();
      else if (s.kind === 'visible') actual = await l.isVisible();
      else if (s.kind === 'enabled') actual = await l.isEnabled();
      else actual = await l.isChecked();
      const wanted = s.kind === 'text' ? s.value.replace(/\s+/g,' ').trim() : s.value;
      if (actual === wanted) return;
    }
    if (Date.now() >= end) throw Error('assertion-timeout');
    await l.waitFor({state:'attached',timeout:Math.max(1,end-Date.now())});
    await new Promise(r => setTimeout(r,20));
  }
}
