import type { Place } from '@riflo/core';
import type { IconName } from '@riflo/ui';
import { t } from '../../i18n';

export const costText = (p: Place) => (p.costPerPerson === null ? t.trip.costUnknown : p.costPerPerson === 0 ? t.trip.free : t.trip.perPerson(p.costPerPerson));

export function placeMeta(p: Place): { icon: IconName; text: string }[] {
  const meta: { icon: IconName; text: string }[] = [{ icon: 'wallet', text: costText(p) }];
  if (p.bestTime !== 'any') meta.push({ icon: 'sun', text: `${t.place.bestTime}: ${t.bestTime[p.bestTime]}` });
  return meta;
}
