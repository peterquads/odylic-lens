// =============================================================================
// Sample creatives for the Hypothetical Funnel Viewer demo (no backend needed).
//
// Thumbnails are inline SVG data-URIs so the demo renders fully offline —
// `toProxyImg` passes `data:` URIs straight through, and these ads carry no
// story_id, so the Thumbnail component uses the data-URI directly. Segment
// blends span every lane (TOF/MOF/BOF/Reactivation/Unclassified) plus a few
// "estimated" ads with no segment delivery, so the freq/CPMr fallback shows.
//
// Used by pages/FunnelDemo.tsx — a public, full-screen, screenshot-ready view.
// =============================================================================

import type { AdCreative } from '../components/AdAnalysisView'

const KICKER = 'LUMIERE'

function tile(concept: string, c1: string, c2: string): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='208' height='276' viewBox='0 0 208 276'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
    `<stop offset='0' stop-color='${c1}'/><stop offset='1' stop-color='${c2}'/>` +
    `</linearGradient></defs>` +
    `<rect width='208' height='276' fill='url(#g)'/>` +
    `<circle cx='104' cy='96' r='42' fill='rgba(255,255,255,0.16)'/>` +
    `<rect x='58' y='150' width='92' height='6' rx='3' fill='rgba(255,255,255,0.28)'/>` +
    `<text x='104' y='102' text-anchor='middle' font-family='Georgia, serif' font-size='19' fill='#ffffff'>${concept}</text>` +
    `<text x='104' y='252' text-anchor='middle' font-family='Georgia, serif' font-size='10' letter-spacing='3' fill='rgba(255,255,255,0.9)'>${KICKER}</text>` +
    `</svg>`
  return 'data:image/svg+xml,' + encodeURIComponent(svg)
}

type Seg = { prospecting: number; engaged: number; existing: number; unknown: number }

let n = 0
function mk(
  name: string,
  concept: string,
  colors: [string, string],
  seg: Seg | null,
  opts: {
    reactivation?: boolean
    frequency?: number
    cpmr?: number
    imageHash?: string   // share across two ads → ×N variants badge
  } = {},
): AdCreative {
  n += 1
  const id = String(700000000000000 + n)
  const total = seg ? seg.prospecting + seg.engaged + seg.existing + seg.unknown : 480
  return {
    ad_id: id,
    ad_name: name,
    account_id: 'act_1088020000',
    campaign_id: '23851000000',
    adset_id: '23852000000' + n,
    creative_hash: 'demo-' + id,
    image_hash: opts.imageHash ?? null,
    image_url: tile(concept, colors[0], colors[1]),
    is_video: false,
    video_id: null,
    spend: total,
    reach: Math.round(total * 22),
    impressions: Math.round(total * 22 * (opts.frequency ?? 1.7)),
    frequency: opts.frequency ?? 1.7,
    cost_per_1k_ac_reached: opts.cpmr ?? 28,
    segment_spend: seg ?? undefined,
    reactivation: !!opts.reactivation,
  } as AdCreative
}

export const SAMPLE_BRAND = 'Lumière Skincare (demo)'

// Cohort model: prospecting→TOF, engaged→MOF(low freq)/BOF(high freq),
// existing→Reactivation, unknown→Unclassified. Ads with no segment delivery
// are placed by the freq/CPMr fallback (dashed "estimated" cards).
export const SAMPLE_FUNNEL_ADS: AdCreative[] = [
  // ---- TOF · prospecting-dominant, low frequency ----
  mk('UGC — “I was skeptical…”', 'UGC', ['#C08457', '#8A5A3B'], { prospecting: 940, engaged: 120, existing: 26, unknown: 14 }, { frequency: 1.3, cpmr: 22 }),
  mk('Founder Story 15s', 'Founder', ['#8FA68E', '#5F7860'], { prospecting: 810, engaged: 90, existing: 20, unknown: 30 }, { frequency: 1.2, cpmr: 19 }),
  mk('Before / After Hook', 'Results', ['#7FA8C9', '#4E7C9E'], { prospecting: 690, engaged: 160, existing: 40, unknown: 20 }, { frequency: 1.5, cpmr: 26 }),
  mk('Problem-Aware Static', 'Dry Skin?', ['#D8B98C', '#B08D5B'], { prospecting: 560, engaged: 70, existing: 18, unknown: 12 }, { frequency: 1.4, cpmr: 24 }),
  mk('Ingredient Spotlight', 'Squalane', ['#9AA870', '#6E7C46'], { prospecting: 520, engaged: 110, existing: 30, unknown: 10 }, { frequency: 1.6, cpmr: 27 }),
  mk('Press Quote — Vogue', 'As Seen In', ['#8A93A6', '#5C6373'], { prospecting: 470, engaged: 60, existing: 22, unknown: 16 }, { frequency: 1.3, cpmr: 21, imageHash: 'shared-press' }),
  mk('Press Quote — Allure', 'As Seen In', ['#8A93A6', '#5C6373'], { prospecting: 300, engaged: 40, existing: 15, unknown: 10 }, { frequency: 1.3, cpmr: 21, imageHash: 'shared-press' }),

  // ---- MOF · engaged-dominant, LOWER freq/CPMr ----
  mk('Retarget — How It Works', 'How It Works', ['#8E6E8E', '#5E4A63'], { prospecting: 140, engaged: 640, existing: 90, unknown: 20 }, { frequency: 1.9, cpmr: 29 }),
  mk('Routine Explainer', 'AM / PM', ['#7FA8C9', '#4E7C9E'], { prospecting: 160, engaged: 410, existing: 60, unknown: 22 }, { frequency: 1.8, cpmr: 28 }),
  mk('Social Proof Wall', '2,400 ★', ['#8FA68E', '#5F7860'], { prospecting: 90, engaged: 480, existing: 110, unknown: 18 }, { frequency: 1.85, cpmr: 27 }),
  mk('Ingredient Deep-Dive', 'The Science', ['#9AA870', '#6E7C46'], { prospecting: 110, engaged: 360, existing: 40, unknown: 14 }, { frequency: 1.7, cpmr: 27 }),

  // ---- BOF · engaged-dominant, HIGHER freq/CPMr (saturated, still non-customer) ----
  mk('Objection: “Too pricey?”', 'Worth It', ['#C08457', '#8A5A3B'], { prospecting: 120, engaged: 520, existing: 70, unknown: 15 }, { frequency: 3.0, cpmr: 43 }),
  mk('Comparison vs. Brand X', 'vs. Others', ['#8E6E8E', '#5E4A63'], { prospecting: 110, engaged: 360, existing: 80, unknown: 14 }, { frequency: 3.3, cpmr: 46 }),
  mk('Urgency — “Selling fast”', 'Almost Gone', ['#C98B8B', '#9E5F63'], { prospecting: 80, engaged: 300, existing: 60, unknown: 12 }, { frequency: 3.6, cpmr: 49 }),
  mk('Retarget Carousel', 'Bestsellers', ['#7FA8C9', '#4E7C9E'], { prospecting: 70, engaged: 280, existing: 50, unknown: 10 }, { frequency: 2.9, cpmr: 41 }),

  // ---- Reactivation · existing-customer cohort ----
  mk('Bundle & Save 20%', 'The Bundle', ['#B4795A', '#7A4A34'], { prospecting: 60, engaged: 120, existing: 560, unknown: 16 }, { frequency: 3.1, cpmr: 44 }),
  mk('Subscribe & Save', 'Subscribe', ['#8A6E5A', '#5C463A'], { prospecting: 40, engaged: 90, existing: 500, unknown: 12 }, { frequency: 3.4, cpmr: 47 }),
  mk('“We miss you” — 25% back', 'Come Back', ['#B4795A', '#7A4A34'], { prospecting: 20, engaged: 60, existing: 500, unknown: 10 }, { reactivation: true, frequency: 3.6, cpmr: 49 }),
  mk('Lapsed 180d Winback', 'Reorder', ['#8A6E5A', '#5C463A'], { prospecting: 15, engaged: 40, existing: 420, unknown: 8 }, { reactivation: true, frequency: 3.2, cpmr: 45 }),

  // ---- Unclassified · Meta couldn't attribute ----
  mk('Broad ASC — mixed reach', 'Advantage+', ['#A6A6A6', '#767676'], { prospecting: 60, engaged: 40, existing: 30, unknown: 420 }, { frequency: 1.9, cpmr: 33 }),

  // ---- Estimated · NO segment delivery → placed by freq/CPMr fallback ----
  mk('Legacy static (no seg)', 'Classic', ['#B9A98C', '#8C7A5E'], null, { frequency: 1.2, cpmr: 18 }),
  mk('Older evergreen (no seg)', 'Evergreen', ['#9BB0A0', '#6E8574'], null, { frequency: 2.1, cpmr: 31 }),
  mk('Retarget remnant (no seg)', 'Remnant', ['#A88C8C', '#6E5252'], null, { frequency: 3.5, cpmr: 52 }),
]
