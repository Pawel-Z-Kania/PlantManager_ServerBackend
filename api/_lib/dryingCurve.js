// Predykcja następnego podlania: wygładzanie po czasie, dopasowanie krzywej logistycznej
// (Levenberg-Marquardt) i zapasowy estymator interwałowy. Czyste funkcje, bez dostępu do bazy.
import { levenbergMarquardt } from 'ml-levenberg-marquardt';

const DAY_SEC = 86400;
const HOUR_SEC = 3600;

// Parametry bramek; wartości poza progami profilu rośliny (plant_types) są stałymi algorytmu.
export const DEFAULT_PREDICTION_OPTIONS = {
  bucketHours: 1,
  minCoverage: 0.5,
  minSmoothedPoints: 6,
  maxRmseAdc: 6,
  maxStdErrorDays: 1,
  maxHorizonDays: 60,
  // Krzywa z małą amplitudą dopasowuje się do plateau po drenażu i daje zaniżone daty (backtest).
  minAmplitudeAdc: 80,
  maxAmplitudeAdc: 400,
  // Dopasowanie jest wiarygodne dopiero, gdy ostatni punkt leży blisko asymptoty (wypłaszczenie widoczne w danych).
  minProgressAtLast: 0.75,
  minRatePerDay: 0.05,
  maxRatePerDay: 5,
  minIntervals: 1,
  minIntervalDays: 1,
  maxIntervalDays: 120,
  // Do czasu zebrania danych kalibracyjnych w logu estymator interwałowy ma pierwszeństwo.
  preferredSource: 'interval',
};

const skip = (reason) => ({ status: 'skip', reason });

// Okno przesuwne po czasie (nie po indeksach), znacznik punktu = środek ciężkości okna.
// Tylko pełne okna, więc brzeg nie jest obciążony skróconym oknem.
export function smoothSeries(points, windowHours, { bucketHours, minCoverage }) {
  if (points.length === 0) return [];

  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  const windowSec = windowHours * HOUR_SEC;
  const stepSec = windowSec / 2;
  const bucketSec = bucketHours * HOUR_SEC;
  const minCount = Math.max(1, Math.ceil((windowHours / bucketHours) * minCoverage));
  const firstT = sorted[0][0];
  const lastT = sorted[sorted.length - 1][0];
  const smoothed = [];

  for (let start = firstT; start + windowSec <= lastT + bucketSec; start += stepSec) {
    let count = 0;
    let sumT = 0;
    let sumY = 0;
    for (const [t, y] of sorted) {
      if (t >= start && t < start + windowSec) {
        count += 1;
        sumT += t;
        sumY += y;
      }
    }
    if (count >= minCount) smoothed.push({ t: sumT / count, y: sumY / count });
  }

  return smoothed;
}

const sigmoid = (k, x, tm) => 1 / (1 + Math.exp(-k * (x - tm)));

const logisticModel = (floor) => ([ceiling, k, tm]) => (x) =>
  floor + (ceiling - floor) * sigmoid(k, x, tm);

const logisticJacobian = (floor) => ([ceiling, k, tm]) => (x) => {
  const s = sigmoid(k, x, tm);
  const ds = s * (1 - s);
  return [s, (ceiling - floor) * ds * (x - tm), -(ceiling - floor) * ds * k];
};

function invert3x3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}

// Dopasowuje y(x) = L + (U - L) / (1 + exp(-k (x - tm))), x w dobach od podlania. L (mokre plateau)
// jest stałe, bo przy niepełnym cyklu swobodne L i U są nieidentyfikowalne.
export function fitLogistic(xs, ys, opts = DEFAULT_PREDICTION_OPTIONS) {
  const n = xs.length;
  const floor = Math.min(...ys) - 1;
  const yLast = ys[n - 1];
  const xLast = xs[n - 1];

  let maxSlope = 0;
  let maxSlopeX = xs[Math.floor(n / 2)];
  for (let i = 1; i < n - 1; i += 1) {
    const slope = (ys[i + 1] - ys[i - 1]) / (xs[i + 1] - xs[i - 1]);
    if (slope > maxSlope) {
      maxSlope = slope;
      maxSlopeX = xs[i];
    }
  }
  if (maxSlope <= 0) return null;

  const minValues = [yLast + 5, opts.minRatePerDay, -2];
  const maxValues = [floor + opts.maxAmplitudeAdc, opts.maxRatePerDay, xLast + 30];
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  let best = null;
  for (const spread of [0.2, 0.6]) {
    const ceiling0 = clamp(yLast + spread * (yLast - floor) + 10, minValues[0], maxValues[0]);
    const k0 = clamp((4 * maxSlope) / (ceiling0 - floor), opts.minRatePerDay, opts.maxRatePerDay);
    for (const kScale of [0.5, 1, 2]) {
      try {
        const fit = levenbergMarquardt({ x: xs, y: ys }, logisticModel(floor), {
          initialValues: [ceiling0, clamp(k0 * kScale, opts.minRatePerDay, opts.maxRatePerDay), maxSlopeX],
          minValues,
          maxValues,
          maxIterations: 200,
          errorTolerance: 1e-6,
          jacobianFunction: logisticJacobian(floor),
        });
        if (fit.parameterValues.every(Number.isFinite) && (!best || fit.parameterError < best.parameterError)) {
          best = fit;
        }
      } catch {
        // Nieudany start nie przerywa pozostałych.
      }
    }
  }
  if (!best) return null;

  const [ceiling, k, tm] = best.parameterValues;
  const model = logisticModel(floor)(best.parameterValues);
  const jacobian = logisticJacobian(floor)(best.parameterValues);
  let sse = 0;
  const jtj = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < n; i += 1) {
    const residual = ys[i] - model(xs[i]);
    sse += residual * residual;
    const row = jacobian(xs[i]);
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 3; c += 1) jtj[r][c] += row[r] * row[c];
    }
  }

  return {
    floor,
    ceiling,
    k,
    tm,
    rmse: Math.sqrt(sse / n),
    sse,
    covarianceUnit: n > 3 ? invert3x3(jtj) : null,
    sigma2: n > 3 ? sse / (n - 3) : null,
    bounds: { minValues, maxValues },
  };
}

function predictFromCurve(input, t0, nowSec, opts) {
  const ageHours = (nowSec - t0) / HOUR_SEC;
  if (ageHours < Number(input.min_cycle_age_hours)) return skip('young_cycle');

  const settledFrom = t0 + Number(input.settle_hours) * HOUR_SEC;
  const settled = (input.points ?? []).filter(([t]) => t >= settledFrom);
  const smoothed = smoothSeries(settled, Number(input.smoothing_window_hours), opts);
  if (smoothed.length < opts.minSmoothedPoints) return skip('too_few_points');

  const xs = smoothed.map((p) => (p.t - t0) / DAY_SEC);
  const ys = smoothed.map((p) => p.y);
  const fit = fitLogistic(xs, ys, opts);
  if (!fit) return skip('fit_failed');

  const { ceiling, floor, k, tm, rmse } = fit;
  const { minValues, maxValues } = fit.bounds;
  const xLast = xs[xs.length - 1];

  if (ceiling - floor < opts.minAmplitudeAdc) return skip('low_amplitude');
  if (rmse > opts.maxRmseAdc) return skip('poor_fit');
  // Asymptota lub tempo na granicy dozwolonego zakresu oznaczają brak identyfikowalności.
  if (ceiling >= maxValues[0] - 1 || k <= minValues[1] * 1.05 || k >= maxValues[1] * 0.95) {
    return skip('unidentifiable');
  }
  if (sigmoid(k, xLast, tm) < opts.minProgressAtLast) return skip('flattening_not_observed');

  const z = Number(input.target_logit);
  const tStarDays = tm + z / k;

  if (!fit.covarianceUnit) return skip('unidentifiable');
  const gradient = [0, -z / (k * k), 1];
  let variance = 0;
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) variance += gradient[r] * fit.covarianceUnit[r][c] * gradient[c];
  }
  // Okna wygładzania nakładają się w 50%, więc wariancję szacujemy z podwójnym zapasem.
  const stdErrorDays = Math.sqrt(Math.max(0, variance * fit.sigma2 * 2));
  if (!Number.isFinite(stdErrorDays) || stdErrorDays > opts.maxStdErrorDays) return skip('uncertain');

  const dateSec = t0 + tStarDays * DAY_SEC;
  if (dateSec < t0) return skip('invalid_prediction');
  if (dateSec > nowSec + opts.maxHorizonDays * DAY_SEC) return skip('horizon_exceeded');

  return {
    status: 'ok',
    source: 'curve',
    dateSec,
    details: {
      k: Number(k.toFixed(4)),
      t_m_days: Number(tm.toFixed(3)),
      floor_adc: Number(floor.toFixed(1)),
      ceiling_adc: Number(ceiling.toFixed(1)),
      rmse_adc: Number(rmse.toFixed(2)),
      std_error_days: Number(stdErrorDays.toFixed(3)),
      target_logit: z,
      smoothed_points: smoothed.length,
      age_hours: Number(ageHours.toFixed(1)),
    },
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Mediana długości poprzednich cykli; nie zależy od krzywej, więc działa także na początku cyklu.
function predictFromIntervals(events, t0, opts) {
  const history = (events ?? []).filter((t) => t <= t0 + 60).sort((a, b) => a - b);
  const intervalsDays = [];
  for (let i = 1; i < history.length; i += 1) {
    const days = (history[i] - history[i - 1]) / DAY_SEC;
    if (days >= opts.minIntervalDays && days <= opts.maxIntervalDays) intervalsDays.push(days);
  }
  if (intervalsDays.length < opts.minIntervals) return skip('not_enough_cycles');

  const medianDays = median(intervalsDays);
  return {
    status: 'ok',
    source: 'interval',
    dateSec: t0 + medianDays * DAY_SEC,
    details: {
      intervals_days: intervalsDays.map((d) => Number(d.toFixed(2))),
      median_days: Number(medianDays.toFixed(2)),
    },
  };
}

// Drabina estymatorów (kolejność wg preferredSource); gdy żaden nie działa -> brak predykcji (NULL).
// Wynik drugiego estymatora trafia do details, żeby log pozwalał porównać oba na realnych cyklach.
export function predictNextWatering(input, nowSec, options = {}) {
  const opts = { ...DEFAULT_PREDICTION_OPTIONS, ...options };
  const t0 = Date.parse(input.last_watered_at) / 1000;
  if (!Number.isFinite(t0)) return skip('invalid_last_watered_at');

  const curve = predictFromCurve(input, t0, nowSec, opts);
  const interval = predictFromIntervals(input.events, t0, opts);
  const ordered = opts.preferredSource === 'curve' ? [curve, interval] : [interval, curve];
  const chosen = ordered.find((result) => result.status === 'ok');
  if (!chosen) return skip(curve.reason);

  const other = chosen === curve ? interval : curve;
  const alternative = other.status === 'ok'
    ? { source: other.source, date: new Date(other.dateSec * 1000).toISOString() }
    : { skip_reason: other.reason };

  return { ...chosen, details: { ...chosen.details, alternative } };
}
