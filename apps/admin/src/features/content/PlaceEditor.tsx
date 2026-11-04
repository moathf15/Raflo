import { ApiError, CITIES, publishProblems, type CategoryId, type Place } from '@riflo/core';
import { Button, IconButton } from '@riflo/ui';
import { useEffect, useState } from 'react';
import { useServices } from '../../app/services';
import { ar as t } from '../../i18n/ar';

type Form = {
  name: string; summary: string; category: CategoryId; visitMinutes: string; cost: string; hoursText: string;
  allDay: boolean; open: string; close: string; closedOn: number[]; source: string; verifiedAt: string;
  bestTime: Place['bestTime']; etiquette: string; lat: string; lng: string;
};
type Errors = Partial<Record<keyof Form | 'form', string>>;

const toHHMM = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const toMinutes = (s: string) => (/^\d{2}:\d{2}$/.test(s) ? Number(s.slice(0, 2)) * 60 + Number(s.slice(3)) : NaN);

const toForm = (p: Place | null): Form => ({
  name: p?.name ?? '',
  summary: p?.summary ?? '',
  category: p?.category ?? 'religious',
  visitMinutes: String(p?.visitMinutes ?? 45),
  cost: p?.costPerPerson == null ? '' : String(p.costPerPerson),
  hoursText: p?.openingHours ?? '',
  allDay: !!p?.hours && p.hours.open === 0 && p.hours.close === 1440,
  open: p?.hours && p.hours.close !== 1440 ? toHHMM(p.hours.open) : '',
  close: p?.hours && p.hours.close !== 1440 ? toHHMM(p.hours.close) : '',
  closedOn: p?.hours?.closedOn ?? [],
  source: p?.source ?? '',
  verifiedAt: p?.verifiedAt ?? '',
  bestTime: p?.bestTime ?? 'any',
  etiquette: p?.etiquette ?? '',
  lat: String(p?.location.lat ?? CITIES[0].location.lat),
  lng: String(p?.location.lng ?? CITIES[0].location.lng)
});

/** Structured hours from the form: all day, a valid open < close window, or none. */
function hoursOf(f: Form): Place['hours'] | 'invalid' {
  const closedOn = [...f.closedOn].sort();
  if (f.allDay) return { open: 0, close: 1440, closedOn };
  if (!f.open && !f.close) return null;
  const open = toMinutes(f.open);
  const close = toMinutes(f.close);
  return Number.isNaN(open) || Number.isNaN(close) || open >= close ? 'invalid' : { open, close, closedOn };
}

function validate(f: Form): Errors {
  const e: Errors = {};
  if (!f.name.trim()) e.name = t.editor.required;
  if (!(Number(f.visitMinutes) >= 5)) e.visitMinutes = t.editor.invalidNumber;
  if (f.cost !== '' && !(Number(f.cost) >= 0)) e.cost = t.editor.invalidNumber;
  if (hoursOf(f) === 'invalid') e.open = t.editor.invalidHours;
  if (!Number.isFinite(Number(f.lat)) || f.lat === '') e.lat = t.editor.invalidNumber;
  if (!Number.isFinite(Number(f.lng)) || f.lng === '') e.lng = t.editor.invalidNumber;
  return e;
}

export function PlaceEditor({ place, onClose, onSaved }: { place: Place | null; onClose: () => void; onSaved: (p: Place) => void }) {
  const { api } = useServices();
  const [form, setForm] = useState<Form>(() => toForm(place));
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((er) => ({ ...er, [k]: undefined, form: undefined }));
  };
  const field = <K extends keyof Form>(k: K) => ({ value: form[k] as string, onChange: (e: { target: { value: string } }) => set(k, e.target.value as Form[K]), 'aria-invalid': !!errors[k] });

  const draftPlace = (): Place => {
    const base: Place = place ?? { id: `place-${Date.now().toString(36)}`, cityId: 'madinah', status: 'draft', updatedAt: '', openReports: 0, name: '', summary: '', category: 'religious', location: CITIES[0].location, visitMinutes: 45, costPerPerson: null, openingHours: null, hours: null, source: null, verifiedAt: null, bestTime: 'any', etiquette: null };
    const hours = hoursOf(form);
    return {
      ...base,
      name: form.name.trim(),
      summary: form.summary.trim(),
      category: form.category,
      visitMinutes: Number(form.visitMinutes),
      costPerPerson: form.cost === '' ? null : Number(form.cost),
      openingHours: form.hoursText.trim() || null,
      hours: hours === 'invalid' ? null : hours,
      source: form.source.trim() || null,
      verifiedAt: form.verifiedAt || null,
      bestTime: form.bestTime,
      etiquette: form.etiquette.trim() || null,
      location: { lat: Number(form.lat), lng: Number(form.lng) }
    };
  };
  // What still blocks publishing, shown before the editor tries (same rule the API enforces).
  const missing = publishProblems(draftPlace(), CITIES.find((c) => c.id === (place?.cityId ?? 'madinah')));

  async function save(publish: boolean) {
    const e = validate(form);
    if (publish && missing.length) e.form = t.editor.cannotPublish(missing.map((m) => t.content.missing[m]));
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const p = draftPlace();
      onSaved(await api.savePlace({ ...p, status: publish ? 'published' : p.status === 'published' ? 'published' : p.status }));
    } catch (err) {
      setErrors({ form: err instanceof ApiError && err.message === 'place_incomplete' ? t.editor.cannotPublish(missing.map((m) => t.content.missing[m])) : t.common.saveFailed });
    } finally {
      setBusy(false);
    }
  }

  const err = (k: keyof Errors) => errors[k] && <span className="err" role="alert">{errors[k]}</span>;

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" role="dialog" aria-modal="true" aria-label={place ? t.editor.editTitle : t.editor.newTitle} onClick={(e) => e.stopPropagation()}>
        <div className="panel__head">
          <h2 className="t-h3">{place ? t.editor.editTitle : t.editor.newTitle}</h2>
          <IconButton icon="close" label={t.common.close} bare onClick={onClose} />
        </div>
        <div className="drawer__body">
          <label className="form-field"><span>{t.editor.name}</span><input {...field('name')} />{err('name')}</label>
          <label className="form-field"><span>{t.editor.summary}</span><textarea rows={2} {...field('summary')} /></label>
          <div className="grid-2">
            <label className="form-field"><span>{t.editor.category}</span>
              <select {...field('category')}>{(Object.keys(t.categories) as CategoryId[]).map((c) => <option key={c} value={c}>{t.categories[c]}</option>)}</select>
            </label>
            <label className="form-field"><span>{t.editor.bestTime}</span>
              <select {...field('bestTime')}>{(Object.keys(t.bestTime) as Place['bestTime'][]).map((b) => <option key={b} value={b}>{t.bestTime[b]}</option>)}</select>
            </label>
          </div>
          <div className="grid-2">
            <label className="form-field"><span>{t.editor.visitMinutes}</span><input inputMode="numeric" {...field('visitMinutes')} />{err('visitMinutes')}</label>
            <label className="form-field"><span>{t.editor.cost}</span><input inputMode="numeric" {...field('cost')} /><small>{t.editor.costHint}</small>{err('cost')}</label>
          </div>
          <fieldset className="form-field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend style={{ fontWeight: 500, marginBottom: 6 }}>{t.editor.hoursTitle}</legend>
            <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={form.allDay} onChange={(e) => set('allDay', e.target.checked)} />{t.editor.allDay}</label>
            {!form.allDay && (
              <div className="grid-2">
                <label className="form-field"><span>{t.editor.opens}</span><input type="time" dir="ltr" {...field('open')} /></label>
                <label className="form-field"><span>{t.editor.closes}</span><input type="time" dir="ltr" {...field('close')} /></label>
              </div>
            )}
            {err('open')}
            <div role="group" aria-label={t.editor.closedOn} style={{ marginTop: 8 }}>
              <span style={{ fontSize: 14 }}>{t.editor.closedOn}</span>
              <div className="row" style={{ flexWrap: 'wrap', gap: 12, marginTop: 4 }}>
                {t.editor.weekdays.map((name, d) => (
                  <label key={d} className="row" style={{ fontSize: 14 }}>
                    <input type="checkbox" checked={form.closedOn.includes(d)} onChange={(e) => set('closedOn', e.target.checked ? [...form.closedOn, d] : form.closedOn.filter((x) => x !== d))} />
                    {name}
                  </label>
                ))}
              </div>
            </div>
            <small>{t.editor.hoursHint}</small>
          </fieldset>
          <label className="form-field"><span>{t.editor.hoursText}</span><input {...field('hoursText')} placeholder={t.editor.hoursTextPlaceholder} /></label>
          <div className="grid-2">
            <label className="form-field"><span>{t.editor.source}</span><input {...field('source')} placeholder={t.editor.sourcePlaceholder} /></label>
            <label className="form-field"><span>{t.editor.verifiedAt}</span><input type="date" dir="ltr" {...field('verifiedAt')} /></label>
          </div>
          <label className="form-field"><span>{t.editor.etiquette}</span><textarea rows={2} {...field('etiquette')} /></label>
          <div className="grid-2">
            <label className="form-field"><span>{t.editor.lat}</span><input inputMode="decimal" dir="ltr" {...field('lat')} />{err('lat')}</label>
            <label className="form-field"><span>{t.editor.lng}</span><input inputMode="decimal" dir="ltr" {...field('lng')} />{err('lng')}</label>
          </div>
          {missing.length > 0 && <p className="t-cap" style={{ color: 'var(--busy-700)', background: 'var(--busy-100)', padding: '8px 12px', borderRadius: 6 }}>{t.editor.publishNeeds(missing.map((m) => t.content.missing[m]))}</p>}
          {err('form')}
        </div>
        <div className="drawer__foot">
          <Button variant="solid" loading={busy} onClick={() => save(true)}>{t.editor.savePublish}</Button>
          <Button loading={busy} onClick={() => save(false)}>{t.editor.saveDraft}</Button>
          <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
        </div>
      </div>
    </div>
  );
}
