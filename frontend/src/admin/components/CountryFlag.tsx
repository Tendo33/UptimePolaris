import { FlagAe } from '@sankyu/react-circle-flags/flags/ae';
import { FlagAr } from '@sankyu/react-circle-flags/flags/ar';
import { FlagAt } from '@sankyu/react-circle-flags/flags/at';
import { FlagAu } from '@sankyu/react-circle-flags/flags/au';
import { FlagBe } from '@sankyu/react-circle-flags/flags/be';
import { FlagBg } from '@sankyu/react-circle-flags/flags/bg';
import { FlagBr } from '@sankyu/react-circle-flags/flags/br';
import { FlagCa } from '@sankyu/react-circle-flags/flags/ca';
import { FlagCh } from '@sankyu/react-circle-flags/flags/ch';
import { FlagCl } from '@sankyu/react-circle-flags/flags/cl';
import { FlagCn } from '@sankyu/react-circle-flags/flags/cn';
import { FlagCz } from '@sankyu/react-circle-flags/flags/cz';
import { FlagDe } from '@sankyu/react-circle-flags/flags/de';
import { FlagDk } from '@sankyu/react-circle-flags/flags/dk';
import { FlagEe } from '@sankyu/react-circle-flags/flags/ee';
import { FlagEs } from '@sankyu/react-circle-flags/flags/es';
import { FlagFi } from '@sankyu/react-circle-flags/flags/fi';
import { FlagFr } from '@sankyu/react-circle-flags/flags/fr';
import { FlagGb } from '@sankyu/react-circle-flags/flags/gb';
import { FlagGr } from '@sankyu/react-circle-flags/flags/gr';
import { FlagHk } from '@sankyu/react-circle-flags/flags/hk';
import { FlagHu } from '@sankyu/react-circle-flags/flags/hu';
import { FlagId } from '@sankyu/react-circle-flags/flags/id';
import { FlagIe } from '@sankyu/react-circle-flags/flags/ie';
import { FlagIl } from '@sankyu/react-circle-flags/flags/il';
import { FlagIn } from '@sankyu/react-circle-flags/flags/in';
import { FlagIs } from '@sankyu/react-circle-flags/flags/is';
import { FlagIt } from '@sankyu/react-circle-flags/flags/it';
import { FlagJp } from '@sankyu/react-circle-flags/flags/jp';
import { FlagKr } from '@sankyu/react-circle-flags/flags/kr';
import { FlagKz } from '@sankyu/react-circle-flags/flags/kz';
import { FlagLt } from '@sankyu/react-circle-flags/flags/lt';
import { FlagLu } from '@sankyu/react-circle-flags/flags/lu';
import { FlagLv } from '@sankyu/react-circle-flags/flags/lv';
import { FlagMo } from '@sankyu/react-circle-flags/flags/mo';
import { FlagMx } from '@sankyu/react-circle-flags/flags/mx';
import { FlagMy } from '@sankyu/react-circle-flags/flags/my';
import { FlagNl } from '@sankyu/react-circle-flags/flags/nl';
import { FlagNo } from '@sankyu/react-circle-flags/flags/no';
import { FlagNz } from '@sankyu/react-circle-flags/flags/nz';
import { FlagPh } from '@sankyu/react-circle-flags/flags/ph';
import { FlagPl } from '@sankyu/react-circle-flags/flags/pl';
import { FlagPt } from '@sankyu/react-circle-flags/flags/pt';
import { FlagRo } from '@sankyu/react-circle-flags/flags/ro';
import { FlagRu } from '@sankyu/react-circle-flags/flags/ru';
import { FlagSa } from '@sankyu/react-circle-flags/flags/sa';
import { FlagSe } from '@sankyu/react-circle-flags/flags/se';
import { FlagSg } from '@sankyu/react-circle-flags/flags/sg';
import { FlagTh } from '@sankyu/react-circle-flags/flags/th';
import { FlagTr } from '@sankyu/react-circle-flags/flags/tr';
import { FlagTw } from '@sankyu/react-circle-flags/flags/tw';
import { FlagUa } from '@sankyu/react-circle-flags/flags/ua';
import { FlagUs } from '@sankyu/react-circle-flags/flags/us';
import { FlagVn } from '@sankyu/react-circle-flags/flags/vn';
import { FlagZa } from '@sankyu/react-circle-flags/flags/za';
import { Globe } from 'lucide-react';
import type { ComponentType } from 'react';

/** Import selected flags rather than the full dynamic registry; unknown regions use the globe icon. / 仅导入选定旗帜，不引入完整动态注册表；未知地区使用地球图标。 */
const FLAGS: Record<string, ComponentType<{ width?: number; height?: number; title?: string }>> = {
  ae: FlagAe, ar: FlagAr, at: FlagAt, au: FlagAu, be: FlagBe, bg: FlagBg, br: FlagBr, ca: FlagCa, ch: FlagCh,
  cl: FlagCl, cn: FlagCn, cz: FlagCz, de: FlagDe, dk: FlagDk, ee: FlagEe, es: FlagEs, fi: FlagFi, fr: FlagFr,
  gb: FlagGb, gr: FlagGr, hk: FlagHk, hu: FlagHu, id: FlagId, ie: FlagIe, il: FlagIl, in: FlagIn, is: FlagIs,
  it: FlagIt, jp: FlagJp, kr: FlagKr, kz: FlagKz, lt: FlagLt, lu: FlagLu, lv: FlagLv, mo: FlagMo, mx: FlagMx,
  my: FlagMy, nl: FlagNl, no: FlagNo, nz: FlagNz, ph: FlagPh, pl: FlagPl, pt: FlagPt, ro: FlagRo, ru: FlagRu,
  sa: FlagSa, se: FlagSe, sg: FlagSg, th: FlagTh, tr: FlagTr, tw: FlagTw, ua: FlagUa, us: FlagUs, vn: FlagVn,
  za: FlagZa, uk: FlagGb,
};

/**
 * The ISO country code an agent's region ends in.
 *
 * The agent assembles `region` from ipinfo as "City, CC" (or "Region, CC"),
 * so the last comma-separated part is the two-letter country when there is one.
 *
 * Agent 将 ipinfo 地区拼成“城市或地区, 国家代码”；最后一段如为两个字母即为国家代码。
 */
export function countryOf(region: string | null | undefined): string | null {
  if (!region) return null;
  const last = region.split(',').pop()?.trim() ?? '';
  return /^[A-Za-z]{2}$/.test(last) ? last.toUpperCase() : null;
}

/** The place part of a region, without its country code. / 地区中除国家代码外的地点部分。 */
export function placeOf(region: string | null | undefined): string | null {
  if (!region) return null;
  const parts = region.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length > 1 && /^[A-Za-z]{2}$/.test(parts[parts.length - 1])) parts.pop();
  return parts.join(', ') || null;
}

export function CountryFlag({ code, size = 16 }: { code: string | null; size?: number }) {
  const Flag = code ? FLAGS[code.toLowerCase()] : undefined;
  if (!Flag) {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-full bg-default-100 text-default-400"
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        <Globe size={Math.round(size * 0.7)} />
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 overflow-hidden rounded-full ring-1 ring-black/5" style={{ width: size, height: size }}>
      <Flag width={size} height={size} title={code ?? undefined} />
    </span>
  );
}
