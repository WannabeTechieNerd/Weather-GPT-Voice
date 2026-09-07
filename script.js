/* ============================================================
   Atmos — Weather UI
   ------------------------------------------------------------
   Live weather: Open-Meteo (no API key needed).
   Chat assistant: Groq API (cloud), configured in
   Settings → AI Weather Assistant.
   ============================================================ */

// ---------------- Settings ----------------

const DEFAULT_SETTINGS = {
  tempUnit: "C",          // "C" | "F"
  windUnit: "kmh",        // "kmh" | "mph"
  timeFormat: "12",       // "12" | "24"
  autoRefresh: true,
  refreshInterval: 15,    // minutes
  notifications: false,
  mistralEnabled: false,
  mistralKey: "",
  mistralModel: "llama-3.1-8b-instant"
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("atmos-settings"));
    return { ...DEFAULT_SETTINGS, ...(saved || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function persistSettings() {
  localStorage.setItem("atmos-settings", JSON.stringify(settings));
}

let settings = loadSettings();
let refreshTimer = null;

// ---------------- Locations (dynamic — saved list persists in localStorage) ----------------

const DEFAULT_LOCATIONS = [
  { name: "Manali, Himachal Pradesh", lat: 32.2432, lon: 77.1892 },
  { name: "Delhi, India", lat: 28.6139, lon: 77.2090 },
  { name: "Mumbai, Maharashtra", lat: 19.0760, lon: 72.8777 },
  { name: "Bengaluru, Karnataka", lat: 12.9716, lon: 77.5946 }
];

function loadSavedLocations() {
  try {
    const saved = JSON.parse(localStorage.getItem("atmos-locations"));
    if (Array.isArray(saved) && saved.length) return saved;
  } catch {}
  return [...DEFAULT_LOCATIONS];
}

function persistSavedLocations() {
  localStorage.setItem("atmos-locations", JSON.stringify(savedLocations));
}

let savedLocations = loadSavedLocations();
const locationCoords = {};
savedLocations.forEach(loc => { locationCoords[loc.name] = { lat: loc.lat, lon: loc.lon }; });

// Placeholder sample data shown before the first live fetch completes,
// and as a fallback if a fetch fails.
const FALLBACK_DATA = {
  tempC: 18, feelsC: 18, highC: 22, lowC: 12, condition: "Loading…",
  windKmh: 0, windDir: "--", humidity: 0, precip: 0,
  uv: 0, uvLabel: "--", sunrise: "--:--", sunset: "--:--"
};

const locations = {};
savedLocations.forEach(loc => { locations[loc.name] = { ...FALLBACK_DATA }; });

let hourlyData = [];
let weeklyData = [];
let currentLocation = (() => {
  try {
    const savedCurrent = JSON.parse(localStorage.getItem("atmos-current-location"));
    if (savedCurrent?.name && savedCurrent?.lat != null && savedCurrent?.lon != null) {
      locationCoords[savedCurrent.name] = { lat: Number(savedCurrent.lat), lon: Number(savedCurrent.lon) };
      if (!locations[savedCurrent.name]) locations[savedCurrent.name] = { ...FALLBACK_DATA };
      return savedCurrent.name;
    }
  } catch {}
  return savedLocations[0].name;
})();

// ---------------- WMO weather code mapping ----------------
// https://open-meteo.com/en/docs — "weather_code" field

function mapWeatherCode(code) {
  if (code === 0) return { condition: "Clear Sky", type: "sun" };
  if (code === 1 || code === 2) return { condition: "Partly Cloudy", type: "partly" };
  if (code === 3) return { condition: "Overcast", type: "cloud" };
  if (code === 45 || code === 48) return { condition: "Foggy", type: "cloud" };
  if ([51, 53, 55, 56, 57].includes(code)) return { condition: "Drizzle", type: "rain" };
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return { condition: "Rain", type: "rain" };
  if ([71, 73, 75, 77, 85, 86].includes(code)) return { condition: "Snow", type: "snow" };
  if ([95, 96, 99].includes(code)) return { condition: "Thunderstorm", type: "storm" };
  return { condition: "Unknown", type: "partly" };
}

const icon = type => ({ sun: "☀", partly: "🌤", cloud: "☁", rain: "☁︎", snow: "❄", storm: "⚡" }[type] || "☀");

function degToCompass(deg) {
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return dirs[Math.round(deg / 22.5) % 16];
}

// ---------------- Open-Meteo fetch ----------------

async function fetchLiveWeather(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m` +
    `&hourly=temperature_2m,weather_code` +
    `&daily=temperature_2m_max,temperature_2m_min,uv_index_max,sunrise,sunset,weather_code` +
    `&timezone=auto&forecast_days=7`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo request failed (${res.status})`);
  const data = await res.json();

  const current = data.current;
  const daily = data.daily;
  const { condition } = mapWeatherCode(current.weather_code);

  const weatherState = {
    tempC: Math.round(current.temperature_2m),
    feelsC: Math.round(current.apparent_temperature),
    highC: Math.round(daily.temperature_2m_max[0]),
    lowC: Math.round(daily.temperature_2m_min[0]),
    condition,
    windKmh: Math.round(current.wind_speed_10m),
    windDir: degToCompass(current.wind_direction_10m),
    humidity: Math.round(current.relative_humidity_2m),
    precip: current.precipitation > 0 ? Math.min(100, Math.round(current.precipitation * 20)) : 0,
    uv: Math.round(daily.uv_index_max[0]),
    uvLabel: uvLabel(daily.uv_index_max[0]),
    sunrise: daily.sunrise[0].slice(11, 16),
    sunset: daily.sunset[0].slice(11, 16)
  };

  // Next 7 hours from "now" for the hourly strip
  const nowHour = new Date().getHours();
  const startIdx = data.hourly.time.findIndex(t => new Date(t).getHours() === nowHour) || 0;
  const hourly = data.hourly.time.slice(startIdx, startIdx + 7).map((t, i) => {
    const idx = startIdx + i;
    const label = i === 0 ? "Now" : new Date(data.hourly.time[idx]).toLocaleTimeString("en-IN", { hour: "numeric", hour12: true });
    const { type } = mapWeatherCode(data.hourly.weather_code[idx]);
    return [label, type, Math.round(data.hourly.temperature_2m[idx])];
  });

  const weekly = daily.time.map((dateStr, i) => {
    const day = new Date(dateStr).toLocaleDateString("en-IN", { weekday: "short" }).toUpperCase();
    const { type } = mapWeatherCode(daily.weather_code[i]);
    return [day, type, Math.round(daily.temperature_2m_max[i]), Math.round(daily.temperature_2m_min[i])];
  });

  return { weatherState, hourly, weekly };
}

// ---------------- Open-Meteo Historical Archive fetch ----------------
// Docs: https://open-meteo.com/en/docs/historical-weather-api
// Same host family as the live forecast call, just the archive endpoint —
// free, no API key, supports up to decades of daily history.

let historyState = {
  years: 10,
  metric: "temp",   // "temp" | "precip" | "wind"
  view: "monthly",  // "monthly" | "yearly"
  monthly: null,    // computed monthly aggregates for the loaded range (seasonal, one point per calendar month)
  yearly: null,     // computed yearly aggregates for the loaded range (one point per calendar year)
  loading: false
};

function isoDateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

async function fetchHistoricalWeather(lat, lon, years) {
  // Archive data usually lags a few days behind "today", so end a week back
  // to avoid requesting a window the API hasn't backfilled yet.
  const end = isoDateDaysAgo(7);
  const endDate = new Date(end);
  const startDate = new Date(endDate);
  startDate.setFullYear(startDate.getFullYear() - years);
  const start = startDate.toISOString().slice(0, 10);

  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
    `&start_date=${start}&end_date=${end}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max` +
    `&timezone=auto`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo archive request failed (${res.status})`);
  return res.json();
}

// Groups the daily archive series into calendar-month averages so N years of
// daily rows collapse into a readable 12-point seasonal chart.
function aggregateMonthly(daily) {
  const buckets = Array.from({ length: 12 }, () => ({
    tMaxSum: 0, tMinSum: 0, precipSum: 0, windSum: 0, count: 0, precipDays: 0
  }));

  daily.time.forEach((dateStr, i) => {
    const month = new Date(dateStr).getMonth();
    const b = buckets[month];
    const tMax = daily.temperature_2m_max[i];
    const tMin = daily.temperature_2m_min[i];
    const precip = daily.precipitation_sum[i];
    const wind = daily.wind_speed_10m_max[i];
    if (tMax != null && tMin != null) {
      b.tMaxSum += tMax; b.tMinSum += tMin; b.count++;
    }
    if (precip != null) { b.precipSum += precip; if (precip > 0) b.precipDays++; }
    if (wind != null) b.windSum += wind;
  });

  const monthNames = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  return buckets.map((b, i) => ({
    label: monthNames[i],
    month: monthNames[i],
    avgHighC: b.count ? b.tMaxSum / b.count : 0,
    avgLowC: b.count ? b.tMinSum / b.count : 0,
    avgPrecipMm: b.count ? b.precipSum / b.count : 0,
    avgWindKmh: b.count ? b.windSum / b.count : 0,
    rainyDayShare: b.count ? b.precipDays / b.count : 0
  }));
}

// Groups the daily archive series into calendar-year buckets so the user can
// see the year-over-year trend instead of the within-year seasonal pattern.
function aggregateYearly(daily) {
  const byYear = new Map();

  daily.time.forEach((dateStr, i) => {
    const year = new Date(dateStr).getFullYear();
    if (!byYear.has(year)) {
      byYear.set(year, { tMaxSum: 0, tMinSum: 0, precipSum: 0, windSum: 0, count: 0, windCount: 0, precipDays: 0 });
    }
    const b = byYear.get(year);
    const tMax = daily.temperature_2m_max[i];
    const tMin = daily.temperature_2m_min[i];
    const precip = daily.precipitation_sum[i];
    const wind = daily.wind_speed_10m_max[i];
    if (tMax != null && tMin != null) {
      b.tMaxSum += tMax; b.tMinSum += tMin; b.count++;
    }
    if (precip != null) { b.precipSum += precip; if (precip > 0) b.precipDays++; }
    if (wind != null) { b.windSum += wind; b.windCount++; }
  });

  return Array.from(byYear.keys()).sort((a, b) => a - b).map(year => {
    const b = byYear.get(year);
    return {
      label: String(year),
      year,
      avgHighC: b.count ? b.tMaxSum / b.count : 0,
      avgLowC: b.count ? b.tMinSum / b.count : 0,
      totalPrecipMm: b.precipSum,
      avgWindKmh: b.windCount ? b.windSum / b.windCount : 0,
      rainyDayShare: b.count ? b.precipDays / b.count : 0
    };
  });
}

function summarizeHistory(daily, monthly) {
  const highs = daily.temperature_2m_max.filter(v => v != null);
  const lows = daily.temperature_2m_min.filter(v => v != null);
  const precipTotal = daily.precipitation_sum.filter(v => v != null).reduce((a, b) => a + b, 0);
  const years = daily.time.length ? (new Date(daily.time[daily.time.length - 1]) - new Date(daily.time[0])) / (365.25 * 86400000) : 1;
  const hottestIdx = daily.temperature_2m_max.reduce((best, v, i) => (v != null && (best === -1 || v > daily.temperature_2m_max[best])) ? i : best, -1);
  const coldestIdx = daily.temperature_2m_min.reduce((best, v, i) => (v != null && (best === -1 || v < daily.temperature_2m_min[best])) ? i : best, -1);

  return {
    avgHighC: highs.length ? highs.reduce((a, b) => a + b, 0) / highs.length : null,
    avgLowC: lows.length ? lows.reduce((a, b) => a + b, 0) / lows.length : null,
    hottestC: hottestIdx !== -1 ? daily.temperature_2m_max[hottestIdx] : null,
    hottestDate: hottestIdx !== -1 ? daily.time[hottestIdx] : null,
    coldestC: coldestIdx !== -1 ? daily.temperature_2m_min[coldestIdx] : null,
    coldestDate: coldestIdx !== -1 ? daily.time[coldestIdx] : null,
    avgAnnualPrecipMm: years > 0 ? precipTotal / years : precipTotal
  };
}

async function loadHistory() {
  const { lat, lon } = locationCoords[currentLocation];
  const statusEl = document.getElementById("historyStatus");
  const chartWrap = document.getElementById("historyChartWrap");
  const summaryWrap = document.getElementById("historySummary");
  const loadBtn = document.getElementById("historyLoadBtn");

  historyState.loading = true;
  loadBtn.disabled = true;
  loadBtn.textContent = "Loading…";
  statusEl.classList.remove("error");
  statusEl.textContent = `Fetching ${historyState.years}-year history for ${currentLocation} from Open-Meteo…`;

  try {
    const data = await fetchHistoricalWeather(lat, lon, historyState.years);
    const daily = data.daily;
    if (!daily || !daily.time || !daily.time.length) throw new Error("No historical data returned");

    const monthly = aggregateMonthly(daily);
    const yearly = aggregateYearly(daily);
    const summary = summarizeHistory(daily, monthly);
    historyState.monthly = monthly;
    historyState.yearly = yearly;
    historyState.summary = summary;

    renderHistoryChart();
    renderHistorySummary(summary);

    chartWrap.hidden = false;
    summaryWrap.hidden = false;
    statusEl.textContent = `Showing ${historyState.years}-year monthly averages (${daily.time[0]} to ${daily.time[daily.time.length - 1]}) for ${currentLocation}.`;
  } catch (err) {
    console.error(err);
    statusEl.classList.add("error");
    statusEl.textContent = "Couldn't fetch historical data from Open-Meteo — please try again.";
    showToast("Historical data request failed");
  } finally {
    historyState.loading = false;
    loadBtn.disabled = false;
    loadBtn.textContent = "Load history";
  }
}

function renderHistorySummary(summary) {
  const grid = document.getElementById("historySummaryGrid");
  if (!grid) return;
  const fmtDate = iso => iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "--";

  grid.innerHTML = `
    <div class="detail">
      <div class="detail-icon">↑</div>
      <div><span>AVG DAILY HIGH</span><strong>${summary.avgHighC != null ? formatTemp(summary.avgHighC) + "°" : "--"}</strong></div>
    </div>
    <div class="detail">
      <div class="detail-icon">↓</div>
      <div><span>AVG DAILY LOW</span><strong>${summary.avgLowC != null ? formatTemp(summary.avgLowC) + "°" : "--"}</strong></div>
    </div>
    <div class="detail">
      <div class="detail-icon">☼</div>
      <div><span>HOTTEST DAY</span><strong>${summary.hottestC != null ? formatTemp(summary.hottestC) + "°" : "--"}</strong><small>${fmtDate(summary.hottestDate)}</small></div>
    </div>
    <div class="detail">
      <div class="detail-icon">❄</div>
      <div><span>COLDEST DAY</span><strong>${summary.coldestC != null ? formatTemp(summary.coldestC) + "°" : "--"}</strong><small>${fmtDate(summary.coldestDate)}</small></div>
    </div>
    <div class="detail">
      <div class="detail-icon">♧</div>
      <div><span>AVG ANNUAL RAINFALL</span><strong>${Math.round(summary.avgAnnualPrecipMm)} mm</strong></div>
    </div>
  `;
}

// Renders a small dependency-free SVG line/bar chart of the 12 monthly
// buckets for whichever metric tab is active.
function renderHistoryChart() {
  const container = document.getElementById("historyChart");
  const legend = document.getElementById("historyLegend");
  const titleEl = document.getElementById("historyChartTitle");
  const isYearly = historyState.view === "yearly";
  const buckets = isYearly ? historyState.yearly : historyState.monthly;
  if (!container || !buckets) return;

  const monthly = buckets; // kept as `monthly` locally — same shape, just per-year when isYearly
  const W = 640, H = 240, padR = 12, padT = 16, padB = 26;

  // The left axis gutter needs to widen for longer unit strings (e.g. "km/h")
  // so the value labels never sit under the plotted data.
  const padLFor = unit => Math.max(34, 20 + unit.length * 6);

  function lineChart(seriesA, seriesB, unit, colorA, colorB, labelA, labelB) {
    const padL = padLFor(unit);
    const chartW = W - padL - padR, chartH = H - padT - padB;
    const x = i => padL + (chartW * i) / (Math.max(monthly.length - 1, 1));

    const allVals = seriesB ? seriesA.concat(seriesB) : seriesA;
    const min = Math.min(...allVals, 0);
    const max = Math.max(...allVals, 1);
    const y = v => padT + chartH - ((v - min) / (max - min || 1)) * chartH;

    const toPath = arr => arr.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");

    const gridLines = [0, 0.5, 1].map(f => {
      const val = min + (max - min) * f;
      const yy = y(val);
      return `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" stroke="rgba(255,255,255,.1)" stroke-width="1"/>
              <text x="${padL - 8}" y="${(yy + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="rgba(255,255,255,.55)">${Math.round(val)}${unit}</text>`;
    }).join("");

    const monthLabels = monthly.map((m, i) =>
      `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="rgba(255,255,255,.6)">${m.label}</text>`
    ).join("");

    const pathA = `<path d="${toPath(seriesA)}" fill="none" stroke="${colorA}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`;
    const dotsA = seriesA.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" fill="${colorA}"/>`).join("");

    let pathB = "", dotsB = "";
    if (seriesB) {
      pathB = `<path d="${toPath(seriesB)}" fill="none" stroke="${colorB}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" stroke-dasharray="5,4"/>`;
      dotsB = seriesB.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" fill="${colorB}"/>`).join("");
    }

    container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${gridLines}${pathB}${dotsB}${pathA}${dotsA}${monthLabels}</svg>`;

    legend.innerHTML = seriesB
      ? `<span><i style="background:${colorA}"></i>${labelA}</span><span><i style="background:${colorB};border-radius:0;"></i>${labelB}</span>`
      : `<span><i style="background:${colorA}"></i>${labelA}</span>`;
  }

  function barChart(series, unit, color, label) {
    const padL = padLFor(unit);
    const chartW = W - padL - padR, chartH = H - padT - padB;

    // Band scale: each category gets an equal-width slot, and the bar sits
    // centered inside it with room either side — that's what keeps the
    // first/last bars (and their value labels) clear of the axes, instead of
    // straddling the y-axis the way a point scale would.
    const slotW = chartW / series.length;
    const barW = slotW * 0.55;
    const xSlot = i => padL + slotW * (i + 0.5);
    const y = v => padT + chartH - (v / Math.max(...series, 1)) * chartH;
    const max = Math.max(...series, 1);

    const bars = series.map((v, i) => {
      const cx = xSlot(i);
      const yy = y(v);
      return `<rect x="${(cx - barW / 2).toFixed(1)}" y="${yy.toFixed(1)}" width="${barW.toFixed(1)}" height="${(padT + chartH - yy).toFixed(1)}" rx="3" fill="${color}"/>`;
    }).join("");

    const gridLines = [0, 0.5, 1].map(f => {
      const val = max * f;
      const yy = y(val);
      return `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" stroke="rgba(255,255,255,.1)" stroke-width="1"/>
              <text x="${padL - 8}" y="${(yy + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="rgba(255,255,255,.55)">${Math.round(val)}${unit}</text>`;
    }).join("");

    const monthLabels = monthly.map((m, i) =>
      `<text x="${xSlot(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="rgba(255,255,255,.6)">${m.label}</text>`
    ).join("");

    container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${gridLines}${bars}${monthLabels}</svg>`;
    legend.innerHTML = `<span><i style="background:${color}"></i>${label}</span>`;
  }

  if (historyState.metric === "temp") {
    titleEl.textContent = isYearly ? "Average Annual High / Low by Year" : "Average Monthly High / Low";
    const highs = monthly.map(m => formatTemp(m.avgHighC));
    const lows = monthly.map(m => formatTemp(m.avgLowC));
    lineChart(highs, lows, `°${settings.tempUnit}`, "#ff9d5c", "#3ee0ff", "Avg High", "Avg Low");
  } else if (historyState.metric === "precip") {
    titleEl.textContent = isYearly ? "Total Rainfall by Year" : "Average Monthly Rainfall";
    const precip = isYearly
      ? monthly.map(m => Math.round(m.totalPrecipMm))
      : monthly.map(m => Math.round(m.avgPrecipMm));
    barChart(precip, "mm", "#3ee0ff", isYearly ? "Total rainfall (mm)" : "Avg rainfall (mm)");
  } else {
    titleEl.textContent = isYearly ? "Average Wind Speed by Year" : "Average Monthly Wind Speed";
    const wind = monthly.map(m => Math.round(settings.windUnit === "mph" ? kmhToMph(m.avgWindKmh) : m.avgWindKmh));
    barChart(wind, settings.windUnit === "mph" ? "mph" : "km/h", "#c86bff", `Avg wind (${settings.windUnit === "mph" ? "mph" : "km/h"})`);
  }
}

document.getElementById("historyLoadBtn")?.addEventListener("click", () => {
  historyState.years = Number(document.getElementById("historyYears").value);
  loadHistory();
});

wireSegmented("historyViewToggle", value => {
  historyState.view = value;
  if (historyState.monthly && historyState.yearly) renderHistoryChart();
});

document.querySelectorAll("#historyMetricTabs [data-history-metric]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#historyMetricTabs [data-history-metric]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    historyState.metric = btn.dataset.historyMetric;
    if (historyState.monthly) renderHistoryChart();
  });
});

function uvLabel(uv) {
  if (uv >= 8) return "Very High";
  if (uv >= 6) return "High";
  if (uv >= 3) return "Moderate";
  return "Low";
}

async function loadLocation(name) {
  const { lat, lon } = locationCoords[name];
  try {
    const { weatherState, hourly, weekly } = await fetchLiveWeather(lat, lon);
    locations[name] = weatherState;
    if (name === currentLocation) {
      hourlyData = hourly;
      weeklyData = weekly;
      renderAll();
    }
  } catch (err) {
    console.error(err);
    showToast("Couldn't reach Open-Meteo — showing last known data");
  }
}

// ---------------- Unit helpers ----------------

const cToF = c => Math.round(c * 9 / 5 + 32);
const kmhToMph = k => Math.round(k * 0.621371);

function formatTemp(celsius) {
  return settings.tempUnit === "F" ? cToF(celsius) : celsius;
}

function formatWind(kmh) {
  return settings.windUnit === "mph" ? `${kmhToMph(kmh)} mph` : `${kmh} km/h`;
}

function formatClock(hhmm) {
  if (hhmm === "--:--") return hhmm;
  const [h, m] = hhmm.split(":").map(Number);
  if (settings.timeFormat === "24") {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(hour12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${period}`;
}

// ---------------- Rendering ----------------

function renderCurrentWeather() {
  const data = locations[currentLocation];
  document.getElementById("temperature").textContent = formatTemp(data.tempC);
  document.getElementById("tempUnitLabel").textContent = settings.tempUnit;
  document.getElementById("feelsLike").textContent = `${formatTemp(data.feelsC)}°`;
  document.getElementById("condition").textContent = data.condition;
  document.getElementById("high").textContent = `${formatTemp(data.highC)}°`;
  document.getElementById("low").textContent = `${formatTemp(data.lowC)}°`;

  document.getElementById("windSpeed").textContent = formatWind(data.windKmh);
  document.getElementById("windDir").textContent = data.windDir;
  document.getElementById("humidity").textContent = `${data.humidity}%`;
  document.getElementById("precip").textContent = `${data.precip}%`;
  document.getElementById("uvIndex").textContent = data.uv;
  document.getElementById("uvLabel").textContent = data.uvLabel;

  document.getElementById("sunriseTime").textContent = formatClock(data.sunrise);
  document.getElementById("sunsetTime").textContent = formatClock(data.sunset);

  document.getElementById("locationName").textContent = currentLocation;
  const chatLoc1 = document.getElementById("chatLocationName");
  const chatLoc2 = document.getElementById("chatLocationNameMsg");
  if (chatLoc1) chatLoc1.textContent = currentLocation;
  if (chatLoc2) chatLoc2.textContent = currentLocation.split(",")[0];
}

function renderHourly() {
  document.getElementById("hourly").innerHTML = hourlyData.map(([time, type, tempC]) => `
    <div class="forecast-item">
      <div class="forecast-time">${time}</div>
      <div class="mini-icon mini-${type}">${icon(type)}</div>
      <div class="forecast-temp">${formatTemp(tempC)}°</div>
    </div>
  `).join("");
}

function renderWeekly() {
  document.getElementById("weekly").innerHTML = weeklyData.map(([day, type, highC, lowC]) => `
    <div class="forecast-item">
      <div class="day">${day}</div>
      <div class="mini-icon mini-${type}">${icon(type)}</div>
      <div class="forecast-temp">${formatTemp(highC)}°</div>
      <span class="low-temp">${formatTemp(lowC)}°</span>
    </div>
  `).join("");
}

function renderAll() {
  renderCurrentWeather();
  renderHourly();
  renderWeekly();
  if (historyState.monthly) {
    renderHistoryChart();
    renderHistorySummary(historyState.summary);
  }
}

function updateClock() {
  const now = new Date();
  document.getElementById("dateText").textContent = now.toLocaleDateString("en-IN", {
    weekday: "long", day: "numeric", month: "long"
  });
  document.getElementById("timeText").textContent = settings.timeFormat === "24"
    ? now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false })
    : now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove("show"), 2400);
}

// ---------------- Location picker ----------------

const locationPickerBtn = document.getElementById("locationPicker");
const locationMenu = document.getElementById("locationMenu");
const savedLocationsList = document.getElementById("savedLocationsList");
const locationSearchInput = document.getElementById("locationSearchInput");
const locationSearchResults = document.getElementById("locationSearchResults");
const useMyLocationBtn = document.getElementById("useMyLocationBtn");
const useMyLocationLabel = document.getElementById("useMyLocationLabel");

locationPickerBtn.addEventListener("click", () => {
  locationMenu.classList.toggle("open");
  locationPickerBtn.classList.toggle("open");
});

document.addEventListener("click", e => {
  if (!e.target.closest("#locationPicker") && !e.target.closest("#locationMenu")) {
    locationMenu.classList.remove("open");
    locationPickerBtn.classList.remove("open");
  }
});

function closeLocationMenu() {
  locationMenu.classList.remove("open");
  locationPickerBtn.classList.remove("open");
}

// Adds (or reuses) a location by name+coords, makes it current, saves it to
// the persisted list, and kicks off a live weather fetch for it.
function selectLocation(name, lat, lon) {
  locationCoords[name] = { lat, lon };
  if (!locations[name]) locations[name] = { ...FALLBACK_DATA };

  const existingIdx = savedLocations.findIndex(l => l.name === name);
  if (existingIdx !== -1) savedLocations.splice(existingIdx, 1);
  savedLocations.unshift({ name, lat, lon });
  if (savedLocations.length > 8) savedLocations = savedLocations.slice(0, 8);
  persistSavedLocations();

  currentLocation = name;
  localStorage.setItem("atmos-current-location", JSON.stringify({ name, lat, lon }));
  renderSavedLocationsList();
  renderCurrentWeather();
  closeLocationMenu();
  locationSearchInput.value = "";
  locationSearchResults.innerHTML = "";
  showToast(`Fetching live weather for ${name}…`);
  loadLocation(name);
  centerMapOnLocation(name);

  // Historical data is per-location; clear any previously loaded chart so
  // stale figures for the old city aren't shown against the new one.
  historyState.monthly = null;
  historyState.yearly = null;
  historyState.summary = null;
  const historyChartWrap = document.getElementById("historyChartWrap");
  const historySummary = document.getElementById("historySummary");
  const historyStatus = document.getElementById("historyStatus");
  if (historyChartWrap) historyChartWrap.hidden = true;
  if (historySummary) historySummary.hidden = true;
  if (historyStatus) {
    historyStatus.classList.remove("error");
    historyStatus.textContent = `Choose a range and tap "Load history" to fetch archive data for ${name}.`;
  }
}

function removeSavedLocation(name, e) {
  e.stopPropagation();
  if (savedLocations.length <= 1) {
    showToast("Keep at least one saved location");
    return;
  }
  savedLocations = savedLocations.filter(l => l.name !== name);
  persistSavedLocations();
  if (currentLocation === name) {
    selectLocation(savedLocations[0].name, savedLocations[0].lat, savedLocations[0].lon);
  } else {
    renderSavedLocationsList();
  }
}

function renderSavedLocationsList() {
  savedLocationsList.innerHTML = savedLocations.map(loc => `
    <div class="location-saved-item">
      <button class="location-select-btn" data-name="${escapeHtml(loc.name)}">
        <span class="${loc.name === currentLocation ? "location-current" : ""}">${escapeHtml(loc.name)}</span>
      </button>
      <button class="location-remove-btn" data-name="${escapeHtml(loc.name)}" aria-label="Remove ${escapeHtml(loc.name)}">✕</button>
    </div>
  `).join("");

  savedLocationsList.querySelectorAll(".location-select-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const loc = savedLocations.find(l => l.name === btn.dataset.name);
      if (loc) selectLocation(loc.name, loc.lat, loc.lon);
    });
  });

  savedLocationsList.querySelectorAll(".location-remove-btn").forEach(btn => {
    btn.addEventListener("click", e => removeSavedLocation(btn.dataset.name, e));
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

renderSavedLocationsList();

// ---------------- Location search (OpenStreetMap Nominatim geocoder) ----------------
// Nominatim is free and has no API key, and — unlike many lightweight geocoders —
// its data comes from OpenStreetMap, which tends to have far better coverage of
// small villages/hamlets than city-focused geocoders. Usage policy: max ~1
// request/second and no heavy automated use — fine for a personal/community app,
// but if this app grows into something with real traffic, self-host Nominatim or
// switch to a paid geocoder (LocationIQ, OpenCage, Mapbox) with a proper key.

let searchDebounceTimer = null;
let searchAbortController = null;

function describeResultType(item) {
  const t = (item.type || item.class || "").replace(/_/g, " ");
  return t || "place";
}

function buildResultLabel(item) {
  const addr = item.address || {};
  const primary = addr.village || addr.hamlet || addr.town || addr.city || addr.suburb ||
    item.name || item.display_name.split(",")[0];
  const region = addr.state_district || addr.county || addr.state || "";
  const country = addr.country || "";
  return [primary, region, country].filter(Boolean).join(", ");
}

async function searchLocations(query) {
  if (searchAbortController) searchAbortController.abort();
  searchAbortController = new AbortController();

  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}` +
    `&format=jsonv2&addressdetails=1&limit=8&countrycodes=in&accept-language=en` +
    `&dedupe=1`;

  const res = await fetch(url, { signal: searchAbortController.signal });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  return res.json();
}

function renderSearchStatus(message) {
  locationSearchResults.innerHTML = `<div class="location-search-status">${escapeHtml(message)}</div>`;
}

function renderSearchResults(results) {
  if (!results.length) {
    renderSearchStatus("No matches — try a nearby town or district name.");
    return;
  }
  locationSearchResults.innerHTML = results.map((item, i) => `
    <button class="location-result-btn" data-idx="${i}">
      <span class="location-result-name">${escapeHtml(buildResultLabel(item))}</span>
      <span class="location-result-meta">${escapeHtml(describeResultType(item))}</span>
    </button>
  `).join("");

  locationSearchResults.querySelectorAll(".location-result-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const item = results[Number(btn.dataset.idx)];
      selectLocation(buildResultLabel(item), Number(item.lat), Number(item.lon));
    });
  });
}

locationSearchInput.addEventListener("input", () => {
  const query = locationSearchInput.value.trim();
  clearTimeout(searchDebounceTimer);

  if (query.length < 3) {
    locationSearchResults.innerHTML = "";
    return;
  }

  renderSearchStatus("Searching…");
  searchDebounceTimer = setTimeout(async () => {
    try {
      const results = await searchLocations(query);
      renderSearchResults(results);
    } catch (err) {
      if (err.name === "AbortError") return;
      console.error(err);
      renderSearchStatus("Couldn't search right now — check your connection.");
    }
  }, 500);
});

// ---------------- Geolocation ("Use my current location") ----------------

async function reverseGeocode(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=jsonv2&addressdetails=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Reverse geocode failed (${res.status})`);
  return res.json();
}

useMyLocationBtn.addEventListener("click", () => {
  if (!("geolocation" in navigator)) {
    showToast("Geolocation isn't supported in this browser");
    return;
  }

  useMyLocationBtn.disabled = true;
  useMyLocationLabel.textContent = "Locating…";

  navigator.geolocation.getCurrentPosition(
    async pos => {
      const { latitude: lat, longitude: lon } = pos.coords;
      let name = `My Location (${lat.toFixed(3)}, ${lon.toFixed(3)})`;
      try {
        const place = await reverseGeocode(lat, lon);
        if (place && place.display_name) name = buildResultLabel(place);
      } catch (err) {
        console.error(err);
        // Fall back to coordinate-based name — weather fetch itself doesn't need the name.
      }
      useMyLocationBtn.disabled = false;
      useMyLocationLabel.textContent = "Use my current location";
      selectLocation(name, lat, lon);
    },
    err => {
      useMyLocationBtn.disabled = false;
      useMyLocationLabel.textContent = "Use my current location";
      const messages = {
        1: "Location access denied — enable it in your browser settings to use this.",
        2: "Couldn't determine your location — try again outdoors or with GPS on.",
        3: "Location request timed out — try again."
      };
      showToast(messages[err.code] || "Couldn't get your location.");
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
  );
});


// ---------------- Automatic startup geolocation ----------------
let startupLocationAttempted = false;

async function detectCurrentLocationOnStartup() {
  if (startupLocationAttempted || !("geolocation" in navigator)) return;
  startupLocationAttempted = true;

  // Do not repeatedly prompt if the browser has already denied permission.
  try {
    if (navigator.permissions?.query) {
      const permission = await navigator.permissions.query({ name: "geolocation" });
      if (permission.state === "denied") return;
    }
  } catch {}

  navigator.geolocation.getCurrentPosition(
    async pos => {
      const { latitude: lat, longitude: lon } = pos.coords;
      try {
        const place = await reverseGeocode(lat, lon);
        const name = place ? buildResultLabel(place) : `My Location (${lat.toFixed(3)}, ${lon.toFixed(3)})`;
        selectLocation(name, lat, lon);
        showToast(`Current location detected: ${name}`);
      } catch (err) {
        console.warn("Startup reverse geocoding failed:", err);
        selectLocation(`My Location (${lat.toFixed(3)}, ${lon.toFixed(3)})`, lat, lon);
      }
    },
    err => {
      // Permission denied/unavailable: keep the existing saved/default location.
      console.info("Startup location not available:", err.message);
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 300000 }
  );
}

// ---------------- Side menu (hamburger) ----------------

const menuBtn = document.getElementById("menuBtn");
const sideMenu = document.getElementById("sideMenu");
const closeMenuBtn = document.getElementById("closeMenuBtn");
const scrim = document.getElementById("scrim");
const settingsPanel = document.getElementById("settingsPanel");

function openSideMenu() {
  sideMenu.classList.add("open");
  scrim.classList.add("show");
  menuBtn.setAttribute("aria-expanded", "true");
}

function closeSideMenu() {
  sideMenu.classList.remove("open");
  menuBtn.setAttribute("aria-expanded", "false");
  if (!settingsPanel.classList.contains("open")) scrim.classList.remove("show");
}

menuBtn.addEventListener("click", openSideMenu);
closeMenuBtn.addEventListener("click", closeSideMenu);

document.querySelectorAll(".side-menu-item[data-target]").forEach(item => {
  item.addEventListener("click", () => {
    document.querySelectorAll(".side-menu-item[data-target]").forEach(i => i.classList.remove("active"));
    item.classList.add("active");
    const target = document.querySelector(item.dataset.target);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    closeSideMenu();
  });
});

document.getElementById("menuAboutBtn").addEventListener("click", () => {
  closeSideMenu();
  showToast("Atmos — live weather via Open-Meteo, chat via Groq.");
});

// ---------------- Settings panel ----------------

const settingsBtn = document.getElementById("settingsBtn");
const closeSettingsBtn = document.getElementById("closeSettingsBtn");
const menuSettingsBtn = document.getElementById("menuSettingsBtn");

function openSettings() {
  settingsPanel.classList.add("open");
  scrim.classList.add("show");
  applySettingsToForm();
}

function closeSettings() {
  settingsPanel.classList.remove("open");
  if (!sideMenu.classList.contains("open")) scrim.classList.remove("show");
}

settingsBtn.addEventListener("click", openSettings);
closeSettingsBtn.addEventListener("click", closeSettings);
menuSettingsBtn.addEventListener("click", () => {
  closeSideMenu();
  openSettings();
});

scrim.addEventListener("click", () => {
  closeSideMenu();
  closeSettings();
});

// Segmented toggles (temp unit / wind unit / time format)
function wireSegmented(id, onChange) {
  const group = document.getElementById(id);
  group.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      group.querySelectorAll("button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      group.dataset.value = btn.dataset.value;
      onChange(btn.dataset.value);
    });
  });
}

wireSegmented("unitTempToggle", value => { settings.tempUnit = value; });
wireSegmented("unitWindToggle", value => { settings.windUnit = value; });
wireSegmented("unitTimeToggle", value => { settings.timeFormat = value; });

// Switches
function wireSwitch(id, onChange) {
  const el = document.getElementById(id);
  el.addEventListener("click", () => {
    const next = el.getAttribute("aria-checked") !== "true";
    el.setAttribute("aria-checked", String(next));
    onChange(next);
  });
}

wireSwitch("autoRefreshToggle", checked => {
  settings.autoRefresh = checked;
  document.getElementById("refreshIntervalRow").classList.toggle("disabled", !checked);
});

wireSwitch("notifToggle", checked => { settings.notifications = checked; });

wireSwitch("assistantToggle", checked => {
  settings.mistralEnabled = checked;
  updateMistralStatus();
});

document.getElementById("refreshInterval").addEventListener("change", e => {
  settings.refreshInterval = Number(e.target.value);
});

const mistralKeyInput = document.getElementById("mistralKeyInput");
const mistralModelSelect = document.getElementById("mistralModel");

mistralKeyInput.addEventListener("input", () => {
  settings.mistralKey = mistralKeyInput.value.trim();
  updateMistralStatus();
});

mistralModelSelect.addEventListener("change", () => {
  settings.mistralModel = mistralModelSelect.value;
  updateMistralStatus();
});

document.getElementById("testMistralBtn").addEventListener("click", async () => {
  const status = document.getElementById("mistralStatus");
  if (!settings.mistralKey) {
    status.textContent = "Add a key above first.";
    status.classList.remove("connected");
    return;
  }
  status.textContent = "Testing…";
  status.classList.remove("connected");
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${settings.mistralKey}` }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    status.textContent = `Key works — ready to use ${mistralModelSelect.options[mistralModelSelect.selectedIndex].text}.`;
    status.classList.add("connected");
  } catch (err) {
    status.textContent = "Key test failed — check it's correct and has quota.";
    status.classList.remove("connected");
  }
});

function updateMistralStatus() {
  const status = document.getElementById("mistralStatus");
  if (!settings.mistralEnabled) {
    status.textContent = "Assistant disabled.";
    status.classList.remove("connected");
  } else if (!settings.mistralKey) {
    status.textContent = "Add a key above to enable the assistant.";
    status.classList.remove("connected");
  } else {
    status.textContent = `Ready — using ${mistralModelSelect.options[mistralModelSelect.selectedIndex].text}. Use "Test API key" to verify.`;
    status.classList.remove("connected");
  }
}

function applySettingsToForm() {
  document.querySelectorAll("#unitTempToggle button").forEach(b => b.classList.toggle("active", b.dataset.value === settings.tempUnit));
  document.querySelectorAll("#unitWindToggle button").forEach(b => b.classList.toggle("active", b.dataset.value === settings.windUnit));
  document.querySelectorAll("#unitTimeToggle button").forEach(b => b.classList.toggle("active", b.dataset.value === settings.timeFormat));

  document.getElementById("autoRefreshToggle").setAttribute("aria-checked", String(settings.autoRefresh));
  document.getElementById("refreshIntervalRow").classList.toggle("disabled", !settings.autoRefresh);
  document.getElementById("refreshInterval").value = String(settings.refreshInterval);
  document.getElementById("notifToggle").setAttribute("aria-checked", String(settings.notifications));

  document.getElementById("assistantToggle").setAttribute("aria-checked", String(settings.mistralEnabled));
  mistralKeyInput.value = settings.mistralKey;
  mistralModelSelect.value = settings.mistralModel;
  updateMistralStatus();
}

document.getElementById("saveSettingsBtn").addEventListener("click", () => {
  persistSettings();
  renderAll();
  updateClock();
  setupAutoRefresh();
  closeSettings();
  showToast("Settings saved");
});

document.getElementById("resetSettingsBtn").addEventListener("click", () => {
  settings = { ...DEFAULT_SETTINGS };
  persistSettings();
  applySettingsToForm();
  renderAll();
  updateClock();
  setupAutoRefresh();
  showToast("Settings reset to defaults");
});


// ---------------- Multilingual UI ----------------
const LANGUAGE_OPTIONS = [
  { code:"en", native:"English", english:"English" },
  { code:"hi", native:"हिन्दी", english:"Hindi" },
  { code:"bn", native:"বাংলা", english:"Bengali" },
  { code:"ta", native:"தமிழ்", english:"Tamil" },
  { code:"te", native:"తెలుగు", english:"Telugu" },
  { code:"mr", native:"मराठी", english:"Marathi" },
  { code:"gu", native:"ગુજરાતી", english:"Gujarati" },
  { code:"kn", native:"ಕನ್ನಡ", english:"Kannada" },
  { code:"ml", native:"മലയാളം", english:"Malayalam" },
  { code:"or", native:"ଓଡ଼ିଆ", english:"Odia" },
  { code:"pa", native:"ਪੰਜਾਬੀ", english:"Punjabi" },
  { code:"ur", native:"اردو", english:"Urdu" }
];

const TRANSLATIONS = {
  en:{
    today:"Today", hourlyForecast:"Hourly Forecast", sevenDayForecast:"7-Day Forecast",
    windAir:"Wind & Air", sunriseSunset:"Sunrise & Sunset", settings:"Settings", aboutAtmos:"About Atmos",
    wind:"WIND", humidity:"HUMIDITY", precipitation:"PRECIPITATION", uvIndex:"UV INDEX",
    sunrise:"SUNRISE", sunset:"SUNSET", feelsLike:"Feels like", savedLocations:"SAVED LOCATIONS",
    units:"Units", temperature:"Temperature", windSpeed:"Wind speed", timeFormat:"Time format",
    preferences:"Preferences", autoRefresh:"Auto-refresh data", refreshInterval:"Refresh interval",
    notifications:"Notifications", liveWeatherData:"Live Weather Data", aiAssistant:"AI Weather Assistant",
    enableAssistant:"Enable assistant", groqApiKey:"Groq API key", model:"Model", testApiKey:"Test API key",
    resetDefaults:"Reset defaults", saveChanges:"Save changes", language:"Language",
    chatPlaceholder:"Ask about the weather...", weatherAssistant:"Weather Assistant",
    map:"Weather Map", mapKicker:"INDIA GIS WEATHER MAP",
    mapTitle:"Live Doppler Radar & IMD Station Synoptic Grid",
    rainfall:"Rainfall Overlay", tempOverlay:"Temperature", windOverlay:"Wind Speed",
    dark:"Dark", streets:"Streets", satellite:"Satellite", rainLegend:"RAINFALL INTENSITY (MM/H)",
    normal:"Normal", watch:"Moderate / Watch", heavy:"Heavy Alert", severe:"Severe"
  },
  hi:{
    today:"आज", hourlyForecast:"प्रति घंटा पूर्वानुमान", sevenDayForecast:"7-दिन का पूर्वानुमान",
    windAir:"हवा और वायु", sunriseSunset:"सूर्योदय और सूर्यास्त", settings:"सेटिंग्स", aboutAtmos:"Atmos के बारे में",
    wind:"हवा", humidity:"नमी", precipitation:"वर्षा", uvIndex:"UV इंडेक्स",
    sunrise:"सूर्योदय", sunset:"सूर्यास्त", feelsLike:"महसूस हो रहा है", savedLocations:"सहेजे गए स्थान",
    units:"इकाइयाँ", temperature:"तापमान", windSpeed:"हवा की गति", timeFormat:"समय प्रारूप",
    preferences:"प्राथमिकताएँ", autoRefresh:"ऑटो-रिफ्रेश", refreshInterval:"रिफ्रेश अंतराल",
    notifications:"सूचनाएँ", liveWeatherData:"लाइव मौसम डेटा", aiAssistant:"AI मौसम सहायक",
    enableAssistant:"सहायक सक्षम करें", groqApiKey:"Groq API कुंजी", model:"मॉडल", testApiKey:"API कुंजी जाँचें",
    resetDefaults:"डिफ़ॉल्ट रीसेट करें", saveChanges:"बदलाव सहेजें", language:"भाषा",
    chatPlaceholder:"मौसम के बारे में पूछें...", weatherAssistant:"मौसम सहायक",
    map:"मौसम मानचित्र", mapKicker:"भारत GIS मौसम मानचित्र",
    mapTitle:"लाइव डॉप्लर रडार और IMD स्टेशन सिनॉप्टिक ग्रिड",
    rainfall:"वर्षा", tempOverlay:"तापमान", windOverlay:"हवा की गति",
    dark:"डार्क", streets:"स्ट्रीट्स", satellite:"सैटेलाइट", rainLegend:"वर्षा तीव्रता (MM/H)",
    normal:"सामान्य", watch:"मध्यम / निगरानी", heavy:"भारी चेतावनी", severe:"गंभीर"
  },
  bn:{
    today:"আজ", hourlyForecast:"প্রতি ঘণ্টার পূর্বাভাস", sevenDayForecast:"৭ দিনের পূর্বাভাস", windAir:"বাতাস",
    sunriseSunset:"সূর্যোদয় ও সূর্যাস্ত", settings:"সেটিংস", aboutAtmos:"Atmos সম্পর্কে", wind:"বাতাস",
    humidity:"আর্দ্রতা", precipitation:"বৃষ্টিপাত", uvIndex:"UV সূচক", sunrise:"সূর্যোদয়", sunset:"সূর্যাস্ত",
    feelsLike:"অনুভূত", savedLocations:"সংরক্ষিত স্থান", units:"একক", temperature:"তাপমাত্রা",
    windSpeed:"বাতাসের গতি", timeFormat:"সময় বিন্যাস", preferences:"পছন্দ", autoRefresh:"অটো রিফ্রেশ",
    refreshInterval:"রিফ্রেশ ব্যবধান", notifications:"বিজ্ঞপ্তি", liveWeatherData:"লাইভ আবহাওয়া ডেটা",
    aiAssistant:"AI আবহাওয়া সহায়ক", enableAssistant:"সহায়ক চালু করুন", groqApiKey:"Groq API কী", model:"মডেল",
    testApiKey:"API কী পরীক্ষা", resetDefaults:"ডিফল্ট রিসেট", saveChanges:"পরিবর্তন সংরক্ষণ", language:"ভাষা",
    chatPlaceholder:"আবহাওয়া সম্পর্কে জিজ্ঞাসা করুন...", weatherAssistant:"আবহাওয়া সহায়ক",
    map:"আবহাওয়া মানচিত্র", mapKicker:"ভারত GIS আবহাওয়া মানচিত্র",
    mapTitle:"লাইভ ডপলার রাডার ও IMD স্টেশন সিনপটিক গ্রিড",
    rainfall:"বৃষ্টিপাত", tempOverlay:"তাপমাত্রা", windOverlay:"বাতাসের গতি", dark:"ডার্ক", streets:"স্ট্রিটস",
    satellite:"স্যাটেলাইট", rainLegend:"বৃষ্টির তীব্রতা (MM/H)", normal:"স্বাভাবিক", watch:"মাঝারি / নজরদারি",
    heavy:"ভারী সতর্কতা", severe:"তীব্র"
  }
};

// For languages not fully translated in the compact dictionary, fall back to English.
// The selector still changes the app language and can be extended without changing the UI.
LANGUAGE_OPTIONS.filter(x => !TRANSLATIONS[x.code]).forEach(x => TRANSLATIONS[x.code] = TRANSLATIONS.en);

let currentLanguage = localStorage.getItem("atmos-language") || "en";

function t(key) {
  return TRANSLATIONS[currentLanguage]?.[key] || TRANSLATIONS.en[key] || key;
}

function applyLanguage() {
  document.documentElement.lang = currentLanguage;
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.dataset.i18n;
    if (TRANSLATIONS[currentLanguage]?.[key]) el.textContent = t(key);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });

  const languagePanelTitle = document.getElementById("languagePanelTitle");
  if (languagePanelTitle) languagePanelTitle.textContent = t("language");

  const mapKicker = document.getElementById("mapKicker");
  const mapTitle = document.getElementById("mapTitle");
  const rainLegendTitle = document.getElementById("rainLegendTitle");
  if (mapKicker) mapKicker.textContent = t("mapKicker");
  if (mapTitle) mapTitle.textContent = t("mapTitle");
  if (rainLegendTitle) rainLegendTitle.textContent = t("rainLegend");

  const legend = {
    legendNormal:"normal", legendWatch:"watch", legendHeavy:"heavy", legendSevere:"severe"
  };
  Object.entries(legend).forEach(([id,key]) => {
    const el = document.getElementById(id); if (el) el.textContent = t(key);
  });

  document.querySelectorAll("[data-map-overlay]").forEach(btn => {
    const key = btn.dataset.mapOverlay === "rainfall" ? "rainfall" :
                btn.dataset.mapOverlay === "temperature" ? "tempOverlay" : "windOverlay";
    btn.textContent = t(key);
  });
  document.querySelectorAll("[data-map-base]").forEach(btn => btn.textContent = t(btn.dataset.mapBase));

  const selected = LANGUAGE_OPTIONS.find(x => x.code === currentLanguage);
  const languageBtn = document.getElementById("languageBtn");
  if (languageBtn) languageBtn.textContent = selected?.native?.slice(0,2) || "文";

  renderLanguageOptions();
}

function renderLanguageOptions() {
  const wrap = document.getElementById("languageOptions");
  if (!wrap) return;
  wrap.innerHTML = LANGUAGE_OPTIONS.map(lang => `
    <button class="language-option ${lang.code === currentLanguage ? "active" : ""}" data-lang="${lang.code}">
      <span class="language-native">${escapeHtml(lang.native)}</span>
      <span class="language-english">${escapeHtml(lang.english)}</span>
    </button>
  `).join("");
  wrap.querySelectorAll(".language-option").forEach(btn => {
    btn.addEventListener("click", () => {
      currentLanguage = btn.dataset.lang;
      localStorage.setItem("atmos-language", currentLanguage);
      applyLanguage();
      closeLanguagePanel();
      showToast(t("language") + ": " + LANGUAGE_OPTIONS.find(x=>x.code===currentLanguage).native);
      // Website language and AI chatbot voice language are independent —
      // the chatbot listens for whatever language the user actually speaks,
      // so we deliberately do NOT touch voiceLanguage/recognition.lang here.
    });
  });
}

const languageBtn = document.getElementById("languageBtn");
const languagePanel = document.getElementById("languagePanel");
const closeLanguageBtn = document.getElementById("closeLanguageBtn");

function closeLanguagePanel() {
  languagePanel?.classList.remove("open");
}

languageBtn?.addEventListener("click", e => {
  e.stopPropagation();
  languagePanel?.classList.toggle("open");
  renderLanguageOptions();
});
closeLanguageBtn?.addEventListener("click", closeLanguagePanel);

document.addEventListener("click", e => {
  if (!e.target.closest("#languagePanel") && !e.target.closest("#languageBtn")) closeLanguagePanel();
});

// ---------------- Auto-refresh ----------------

function setupAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  if (!settings.autoRefresh) return;
  refreshTimer = setInterval(() => {
    loadLocation(currentLocation);
setTimeout(() => detectCurrentLocationOnStartup(), 650);
  }, settings.refreshInterval * 60 * 1000);
}

// ---------------- Groq chat assistant (uses mistral* var/id names internally) ----------------

const chatFab = document.getElementById("chatFab");
const chatPanel = document.getElementById("chatPanel");
const closeChatBtn = document.getElementById("closeChatBtn");
const chatMessages = document.getElementById("chatMessages");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");

chatFab.addEventListener("click", () => {
  const wasOpen = chatPanel.classList.contains("open");
  chatPanel.classList.add("open");
  // Opening the assistant should default to listening immediately — the
  // user tapped the mic-branded FAB to talk, not to read a blank panel.
  if (!wasOpen) {
    setTimeout(() => startListening(), 220); // let the open animation begin first
  }
});
closeChatBtn.addEventListener("click", () => chatPanel.classList.remove("open"));

function appendChatBubble(text, cls) {
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble ${cls}`;
  bubble.textContent = text;
  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return bubble;
}

chatForm.addEventListener("submit", async e => {
  e.preventDefault();
  const question = chatInput.value.trim();
  if (!question) return;
  chatInput.value = "";
  appendChatBubble(question, "user");

  if (!settings.mistralEnabled || !settings.mistralKey) {
    appendChatBubble("Add and enable a Groq API key in Settings → AI Weather Assistant to use chat.", "error");
    return;
  }

  const loadingBubble = appendChatBubble("Thinking…", "loading");
  try {
    const answer = await askMistral(question);
    loadingBubble.remove();
    appendChatBubble(answer, "assistant");
  } catch (err) {
    console.error(err);
    loadingBubble.remove();
    appendChatBubble(`Couldn't reach Groq — ${err.message || "check your API key and try again."}`, "error");
  }
});

/**
 * Sends `question` to the Groq API along with the current live
 * conditions for `currentLocation`, so answers are grounded in
 * real data rather than guesses.
 *
 * IMPORTANT: this calls api.groq.com directly from the browser
 * using the key saved in Settings. That's fine for local/personal
 * use, but if you deploy this site publicly, anyone can open dev
 * tools, read the key out of localStorage or the network tab, and
 * spend your quota. For a public deployment, put this call behind
 * a small backend/serverless proxy that holds the key server-side
 * instead — the browser calls your proxy, your proxy calls Groq.
 */
async function askMistral(question) {
  const data = locations[currentLocation];
  const contextSummary =
    `Location: ${currentLocation}. ` +
    `Condition: ${data.condition}. Temperature: ${formatTemp(data.tempC)}°${settings.tempUnit} ` +
    `(feels like ${formatTemp(data.feelsC)}°${settings.tempUnit}). ` +
    `High/Low: ${formatTemp(data.highC)}°/${formatTemp(data.lowC)}°. ` +
    `Wind: ${formatWind(data.windKmh)} ${data.windDir}. Humidity: ${data.humidity}%. ` +
    `Precipitation chance: ${data.precip}%. UV index: ${data.uv} (${data.uvLabel}). ` +
    `Sunrise: ${formatClock(data.sunrise)}, Sunset: ${formatClock(data.sunset)}.`;

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.mistralKey}`
    },
    body: JSON.stringify({
      model: settings.mistralModel || "llama-3.1-8b-instant",
      messages: [
        {
          role: "system",
          content: "You are a friendly weather assistant inside a weather app. Use only the live " +
            "conditions the user gives you to answer — don't invent numbers. Give a complete, " +
            "natural answer (usually 2-6 sentences) — don't cut yourself off or trail into a " +
            "half-finished thought. Keep it conversational and practical."
        },
        { role: "user", content: `Current conditions:\n${contextSummary}\n\nQuestion: ${question}` }
      ],
      temperature: 0.6,
      max_tokens: 600
    })
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    if (res.status === 429) throw new Error("Rate limit exceeded — wait a moment or check your Groq plan limits.");
    throw new Error(errBody?.error?.message || `Groq request failed (${res.status})`);
  }

  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content;
  return (text || "").trim() || "I couldn't come up with an answer for that.";
}


// ---------------- Interactive India Weather Map ----------------
let weatherMap = null;
let mapBaseLayers = {};
let mapOverlayLayers = {};
let mapMarker = null;
let currentMapOverlay = "rainfall";
let currentMapBase = "dark";

function initWeatherMap() {
  const mapEl = document.getElementById("weatherMap");
  if (!mapEl || typeof L === "undefined") return;

  weatherMap = L.map(mapEl, {
    center: [22.5, 79.0],
    zoom: 5,
    minZoom: 4,
    maxZoom: 12,
    zoomControl: true
  });

  mapBaseLayers.dark = L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    { attribution: '&copy; OpenStreetMap &copy; CARTO', maxZoom: 20 }
  ).addTo(weatherMap);

  mapBaseLayers.streets = L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    { attribution: '&copy; OpenStreetMap contributors', maxZoom: 19 }
  );

  mapBaseLayers.satellite = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { attribution: '&copy; Esri', maxZoom: 19 }
  );

  // Rainviewer public radar tiles for a genuinely weather-oriented layer.
  // If the radar endpoint is unavailable, the map itself still works.
  mapOverlayLayers.rainfall = L.tileLayer(
    "https://tilecache.rainviewer.com/v2/radar/nowcast_0/256/{z}/{x}/{y}/2/1_1.png",
    { opacity: .52, attribution: 'Radar tiles by RainViewer' }
  ).addTo(weatherMap);

  // Visual India-wide station/grid overlay using weather station markers.
  mapOverlayLayers.temperature = L.layerGroup();
  mapOverlayLayers.wind = L.layerGroup();
  addIndiaWeatherStations();

  mapMarker = L.marker([22.5,79.0]).addTo(weatherMap);

  document.querySelectorAll("[data-map-base]").forEach(btn => {
    btn.addEventListener("click", () => {
      const base = btn.dataset.mapBase;
      Object.values(mapBaseLayers).forEach(layer => weatherMap.removeLayer(layer));
      mapBaseLayers[base].addTo(weatherMap);
      currentMapBase = base;
      document.querySelectorAll("[data-map-base]").forEach(b => b.classList.toggle("active", b === btn));
    });
  });

  document.querySelectorAll("[data-map-overlay]").forEach(btn => {
    btn.addEventListener("click", () => {
      setMapOverlay(btn.dataset.mapOverlay);
      document.querySelectorAll("[data-map-overlay]").forEach(b => b.classList.toggle("active", b === btn));
    });
  });

  // The map has no location button of its own — it always follows whatever
  // location is currently selected up in the top location picker.
  centerMapOnLocation(currentLocation);

  setTimeout(() => weatherMap.invalidateSize(), 250);
}

function addIndiaWeatherStations() {
  const stations = [
    ["Delhi",28.6139,77.2090],["Mumbai",19.0760,72.8777],["Bengaluru",12.9716,77.5946],
    ["Chennai",13.0827,80.2707],["Kolkata",22.5726,88.3639],["Hyderabad",17.3850,78.4867],
    ["Jaipur",26.9124,75.7873],["Lucknow",26.8467,80.9462],["Ahmedabad",23.0225,72.5714],
    ["Bhopal",23.2599,77.4126],["Patna",25.5941,85.1376],["Guwahati",26.1445,91.7362],
    ["Srinagar",34.0837,74.7973],["Shimla",31.1048,77.1734],["Manali",32.2432,77.1892],
    ["Pune",18.5204,73.8567],["Nagpur",21.1458,79.0882],["Kochi",9.9312,76.2673],
    ["Bhubaneswar",20.2961,85.8245],["Chandigarh",30.7333,76.7794]
  ];
  stations.forEach(([name,lat,lon]) => {
    L.circleMarker([lat,lon], {
      radius:5, weight:1, color:"#fff", fillOpacity:.75, fillColor:"#4fb8ff"
    }).bindTooltip(name, {direction:"top"}).addTo(mapOverlayLayers.temperature);
  });
  mapOverlayLayers.temperature.addTo(weatherMap);

  stations.forEach(([name,lat,lon], i) => {
    L.marker([lat,lon], {
      icon: L.divIcon({
        className:"wind-arrow-marker",
        html:`<span style="display:block;transform:rotate(${(i*37)%360}deg);font-size:17px">➤</span>`,
        iconSize:[20,20], iconAnchor:[10,10]
      })
    }).bindTooltip(name).addTo(mapOverlayLayers.wind);
  });
}

function setMapOverlay(type) {
  if (!weatherMap) return;
  currentMapOverlay = type;
  Object.values(mapOverlayLayers).forEach(layer => weatherMap.removeLayer(layer));
  if (mapOverlayLayers[type]) mapOverlayLayers[type].addTo(weatherMap);
}

// Centers the GIS map on whichever location is currently selected up in the
// top location picker, and drops the marker + popup there. Called on map
// init and again every time the user picks a new location.
function centerMapOnLocation(name) {
  if (!weatherMap) return;
  const coords = locationCoords[name];
  if (!coords) return;
  weatherMap.setView([coords.lat, coords.lon], 8, { animate: true });
  if (mapMarker) {
    mapMarker.setLatLng([coords.lat, coords.lon]);
    mapMarker.bindPopup(`📍 ${escapeHtml(name)}`);
  }
}

// Load Leaflet before map initialization.
const leafletScript = document.createElement("script");
leafletScript.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
leafletScript.onload = () => setTimeout(initWeatherMap, 100);
document.head.appendChild(leafletScript);

// ---------------- Init ----------------

applySettingsToForm();
renderAll();
updateClock();
setInterval(updateClock, 1000);
setupAutoRefresh();
applyLanguage();
loadLocation(currentLocation);

// ============================================================
//  VOICE COMMAND MODULE
//  - Mic button: starts STT, auto-following whichever language
//    the user is actually speaking (independent of site UI language)
//  - Understands: location changes + weather questions
//  - TTS: replies back in that same spoken language
// ============================================================

// The website's `currentLanguage` (see applyLanguage() above) only controls
// on-screen text. The chatbot's spoken language is tracked separately here,
// so switching the site to Hindi text doesn't force the assistant to listen
// or reply in Hindi, and vice versa — it follows what the user says out loud.
let voiceLanguage = localStorage.getItem("atmos-voice-language") || null; // null = auto

function setVoiceLanguage(code) {
  voiceLanguage = code;
  if (code) localStorage.setItem("atmos-voice-language", code);
  else localStorage.removeItem("atmos-voice-language");
}

// Cheap script/keyword sniff so a transcript can shift the *next* turn's
// recognition + the TTS reply toward the language actually spoken, even
// though the recognizer needs a language hint up front and can't truly
// auto-detect mid-utterance.
const SCRIPT_LANG_HINTS = [
  { code: "hi", re: /[\u0900-\u097F]/ },   // Devanagari (Hindi/Marathi)
  { code: "bn", re: /[\u0980-\u09FF]/ },   // Bengali
  { code: "ta", re: /[\u0B80-\u0BFF]/ },   // Tamil
  { code: "te", re: /[\u0C00-\u0C7F]/ },   // Telugu
  { code: "kn", re: /[\u0C80-\u0CFF]/ },   // Kannada
  { code: "ml", re: /[\u0D00-\u0D7F]/ },   // Malayalam
  { code: "gu", re: /[\u0A80-\u0AFF]/ },   // Gujarati
  { code: "pa", re: /[\u0A00-\u0A7F]/ },   // Gurmukhi (Punjabi)
  { code: "or", re: /[\u0B00-\u0B7F]/ },   // Odia
  { code: "ur", re: /[\u0600-\u06FF]/ },   // Arabic script (Urdu)
];

function detectSpokenLanguage(text) {
  for (const { code, re } of SCRIPT_LANG_HINTS) {
    if (re.test(text)) return code;
  }
  // Romanized Hindi/Hinglish is common with browser STT set to en-*.
  if (/\b(kya|kaisa|kaisi|hai|nahi|mausam|kitna|kitni|batao|bolo)\b/i.test(text)) return "hi";
  return null;
}

// ---- Language → BCP-47 speech locale mapping ----
const SPEECH_LOCALE = {
  en: "en-IN",
  hi: "hi-IN",
  bn: "bn-IN",
  ta: "ta-IN",
  te: "te-IN",
  mr: "mr-IN",
  gu: "gu-IN",
  kn: "kn-IN",
  ml: "ml-IN",
  or: "or-IN",
  pa: "pa-IN",
  ur: "ur-PK"
};

// ---- AI-powered intent classifier ----
// Sends the raw transcript to Groq and asks it to classify:
//   { intent: "change_location", location: "<city name in English>" }
//   { intent: "weather_question" }
// Returns the parsed object, or null if AI is unavailable (fallback to regex).

// ---- Pre-flight: detect bare location phrases before hitting the AI ----
// A transcript that is ONLY 1-3 words, contains no question words, and no
// weather-condition words is almost certainly a location change command.
const QUESTION_WORDS = /\b(should|will|is|are|can|what|how|why|when|does|do|tell|give|show me the|umbrella|rain|hot|cold|temperature|forecast|today|tomorrow|kya|kaisa|kaisi|batao|bolo|kitna|kitni)\b/i;

function isBareLocationPhrase(text) {
  const words = text.trim().split(/\s+/);
  // 1–4 words, no question/condition words, no punctuation like ?
  return words.length <= 4 && !QUESTION_WORDS.test(text) && !/[?।॥]/.test(text);
}

async function classifyVoiceIntent(transcript) {
  // Fast path: if it looks like a bare location phrase, skip the API call entirely
  if (isBareLocationPhrase(transcript)) {
    return { intent: "change_location", location: transcript.trim() };
  }

  if (!settings.mistralEnabled || !settings.mistralKey) return null;

  const systemPrompt = `You are a voice-command parser for a weather app. The user spoke in any language (English, Hindi, Bengali, Tamil, Telugu, Marathi, Gujarati, Kannada, Malayalam, Punjabi, Urdu, etc.).

Respond ONLY with one JSON object, no markdown:
- Location change: {"intent":"change_location","location":"<city in English>"}
- Weather question: {"intent":"weather_question"}

CRITICAL RULES — read carefully:
1. ANY city/place name spoken alone = change_location. "Delhi", "Mumbai", "Jaipur", "New York" are ALL change_location.
2. "weather in X", "X weather", "X ka mausam", "X mein dikhao" = change_location with location=X.
3. "go to X", "switch to X", "change to X", "open X" = change_location with location=X.
4. Only mark weather_question if the user is asking ABOUT conditions: "will it rain?", "should I carry umbrella?", "is it hot today?", "kya aaj baarish hogi?", "UV index kya hai?"
5. When in doubt between the two, choose change_location.

Examples:
"Delhi" → {"intent":"change_location","location":"Delhi"}
"Mumbai" → {"intent":"change_location","location":"Mumbai"}  
"go to Bengaluru" → {"intent":"change_location","location":"Bengaluru"}
"Bengaluru weather" → {"intent":"change_location","location":"Bengaluru"}
"Delhi ka mausam dikhao" → {"intent":"change_location","location":"Delhi"}
"Chennai க்கு மாற்று" → {"intent":"change_location","location":"Chennai"}
"should I carry an umbrella?" → {"intent":"weather_question"}
"is it hot today?" → {"intent":"weather_question"}
"kya aaj baarish hogi?" → {"intent":"weather_question"}`;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.mistralKey}`
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: transcript }
        ],
        temperature: 0,
        max_tokens: 60
      })
    });
    if (!res.ok) return null;
    const json = await res.json();
    const raw = (json?.choices?.[0]?.message?.content || "").trim();
    // Strip any accidental markdown fences
    const clean = raw.replace(/^```[a-z]*\n?/, "").replace(/```$/, "").trim();
    return JSON.parse(clean);
  } catch (e) {
    console.warn("Intent classification failed:", e);
    return null;
  }
}

// ---- Regex fallback for when AI is unavailable ----
const LOCATION_TRIGGERS_FALLBACK = [
  // English
  /\b(?:change(?:\s+(?:location|city|place))?|go\s+to|switch\s+to|show(?:\s+me)?|set(?:\s+location)?\s+to|weather\s+(?:in|at|for|of))\s+(.+)/i,
  /^(.+?)\s+(?:weather|forecast|mausam|aabohawa|vanilai)$/i,
  /^(.+?)(?:\s+(?:ka|ke|ki|mein|me)\s+mausam|\s+weather)$/i,
  // Just a city name (2-30 chars, no question mark)
  /^([A-Za-z\u0900-\u097F\u0980-\u09FF\u0B80-\u0BFF\u0C00-\u0C7F\u0A00-\u0A7F]{2,30}(?:\s+[A-Za-z\u0900-\u097F]{2,20})?)$/
];

// ---- Voice Status Bar helpers ----
const voiceStatusBar = document.getElementById("voiceStatusBar");

function setVoiceStatus(msg, type = "") {
  voiceStatusBar.textContent = msg;
  voiceStatusBar.className = "voice-status-bar" + (msg ? " visible" : "") + (type ? " " + type : "");
  if (msg) {
    clearTimeout(setVoiceStatus._t);
    if (type !== "listening") {
      setVoiceStatus._t = setTimeout(() => setVoiceStatus(""), 3500);
    }
  }
}

// ---- TTS: speak a string in the current app language ----
let currentUtterance = null;
let ttsWatchdog = null;
let ttsResumeNudge = null;

function speakText(text, onDone) {
  if (!("speechSynthesis" in window)) { onDone?.(); return; }

  const synth = window.speechSynthesis;

  const cleanup = () => {
    clearTimeout(ttsWatchdog);
    clearInterval(ttsResumeNudge);
    ttsWatchdog = null;
    ttsResumeNudge = null;
  };

  const finish = () => {
    cleanup();
    currentUtterance = null;
    setOrbState("idle");
    setWaveBar(null);
    onDone?.();
  };

  synth.cancel();

  // Chrome sometimes drops the utterance (never fires onstart/onend) if
  // speak() is called in the same tick as cancel(), or if the tab was
  // backgrounded. A short delay before speaking avoids most of that.
  setTimeout(() => {
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = (voiceLanguage && SPEECH_LOCALE[voiceLanguage]) || "en-IN";
    utter.rate = 0.95;
    utter.pitch = 1.0;

    let started = false;

    utter.onstart = () => {
      started = true;
      clearTimeout(ttsWatchdog);
      setOrbState("speaking");
      setWaveBar("speaking", "Speaking…");

      // Chrome can silently pause long utterances after ~15s; nudging
      // resume() periodically keeps audio + visual state in sync.
      clearInterval(ttsResumeNudge);
      ttsResumeNudge = setInterval(() => {
        if (synth.speaking && !synth.paused) {
          synth.pause();
          synth.resume();
        }
      }, 10000);
    };

    utter.onend = finish;
    utter.onerror = finish;

    currentUtterance = utter;

    // Watchdog: if onstart never fires (utterance silently dropped),
    // don't leave the orb/wave stuck in "speaking" mode forever.
    clearTimeout(ttsWatchdog);
    ttsWatchdog = setTimeout(() => {
      if (!started) {
        synth.cancel();
        finish();
      }
    }, 4000);

    synth.speak(utter);
  }, 60);
}

function stopSpeaking() {
  clearTimeout(ttsWatchdog);
  clearInterval(ttsResumeNudge);
  ttsWatchdog = null;
  ttsResumeNudge = null;
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  currentUtterance = null;
  setOrbState("idle");
  setWaveBar(null);
}

// ---- Add speak button to every assistant bubble ----
const _origAppendBubble = appendChatBubble;
// We patch appendChatBubble to also attach a speak button on assistant/error bubbles
function appendChatBubbleWithSpeak(text, cls) {
  const bubble = _origAppendBubble(text, cls);
  if ((cls === "assistant" || cls === "error") && "speechSynthesis" in window) {
    const btn = document.createElement("button");
    btn.className = "speak-btn";
    btn.innerHTML = "🔊 Speak";
    btn.type = "button";
    btn.title = "Read aloud";
    btn.addEventListener("click", () => {
      if (btn.classList.contains("speaking")) {
        stopSpeaking();
        btn.classList.remove("speaking");
        btn.innerHTML = "🔊 Speak";
        return;
      }
      // Stop other speak buttons
      document.querySelectorAll(".speak-btn.speaking").forEach(b => {
        b.classList.remove("speaking"); b.innerHTML = "🔊 Speak";
      });
      btn.classList.add("speaking");
      btn.innerHTML = "⏹ Stop";
      speakText(text, () => {
        btn.classList.remove("speaking");
        btn.innerHTML = "🔊 Speak";
      });
    });
    bubble.appendChild(btn);
  }
  return bubble;
}
// Monkey-patch: replace the original. chatForm submit already uses appendChatBubble
// so we just reassign in the module scope. We also need to update the chatForm handler.
// Since chatForm listener is already attached, we override the global reference:
window._voiceAppendBubble = appendChatBubbleWithSpeak;

// ---- Regex fallback: extract location from transcript ----
function extractLocationFallback(transcript) {
  for (const rx of LOCATION_TRIGGERS_FALLBACK) {
    const m = transcript.match(rx);
    if (m) {
      const loc = (m[1] || "").trim().replace(/[?।॥!]+$/, "");
      // Reject obvious non-location phrases
      if (loc.length >= 2 && !/\b(should|will|is|are|can|what|how|why|when|kya|kaise|kaisa)\b/i.test(loc)) {
        return loc;
      }
    }
  }
  return null;
}

// ---- Geocode and switch location ----
async function handleVoiceLocationChange(locationQuery) {
  setVoiceStatus(`🔍 Searching for "${locationQuery}"…`);
  try {
    const results = await searchLocations(locationQuery);
    if (!results.length) {
      setVoiceStatus(`Couldn't find "${locationQuery}"`, "error");
      const reply = `I couldn't find a place called "${locationQuery}". Try saying just the city name clearly.`;
      appendChatBubbleWithSpeak(reply, "error");
      speakText(reply);
      return;
    }
    const best = results[0];
    const name = buildResultLabel(best);
    selectLocation(name, Number(best.lat), Number(best.lon));
    setVoiceStatus(`📍 Switched to ${name}`, "success");
    const reply = `Done! Switched to ${name} and fetching live weather now.`;
    appendChatBubbleWithSpeak(reply, "assistant");
    speakText(reply);
  } catch (err) {
    console.error(err);
    setVoiceStatus("Location search failed", "error");
    appendChatBubbleWithSpeak("Couldn't search for that location right now — check your connection.", "error");
  }
}

// ---- Handle a full voice transcript ----
async function handleVoiceTranscript(transcript) {
  const trimmed = transcript.trim();
  if (!trimmed) return;

  // Follow whatever language the user just spoke in — independent of the
  // site's display language — so the next listen + the spoken reply below
  // both match it, without the user having to set anything manually.
  const detected = detectSpokenLanguage(trimmed);
  if (detected && detected !== voiceLanguage) setVoiceLanguage(detected);

  setVoiceStatus(`🎙 "${trimmed}"`);

  // Show in chat as user bubble
  appendChatBubbleWithSpeak(trimmed, "user");

  // ── Step 1: Try AI intent classification (uses Groq if key is set) ──
  const aiIntent = await classifyVoiceIntent(trimmed);

  if (aiIntent?.intent === "change_location" && aiIntent.location) {
    await handleVoiceLocationChange(aiIntent.location);
    return;
  }

  if (aiIntent?.intent === "weather_question") {
    // AI understood it as a weather question — go straight to askMistral
    if (!settings.mistralEnabled || !settings.mistralKey) {
      const reply = "Enable the AI assistant in Settings to answer weather questions by voice.";
      appendChatBubbleWithSpeak(reply, "error");
      speakText(reply);
      return;
    }
    const loadingBubble = _origAppendBubble("Thinking…", "loading");
    try {
      const answer = await askMistral(trimmed);
      loadingBubble.remove();
      appendChatBubbleWithSpeak(answer, "assistant");
      speakText(answer);
    } catch (err) {
      loadingBubble.remove();
      const errMsg = `Couldn't reach the assistant — ${err.message || "try again."}`;
      appendChatBubbleWithSpeak(errMsg, "error");
    }
    return;
  }

  // ── Step 2: Regex/bare-word fallback when AI key is missing / offline ──
  if (isBareLocationPhrase(trimmed)) {
    await handleVoiceLocationChange(trimmed.trim());
    return;
  }
  const locFallback = extractLocationFallback(trimmed);
  if (locFallback) {
    await handleVoiceLocationChange(locFallback);
    return;
  }

  // ── Step 3: Treat as a weather question without AI ──
  if (!settings.mistralEnabled || !settings.mistralKey) {
    const reply = "Enable the AI assistant in Settings → AI Weather Assistant to ask weather questions by voice.";
    appendChatBubbleWithSpeak(reply, "error");
    speakText(reply);
    return;
  }

  const loadingBubble = _origAppendBubble("Thinking…", "loading");
  try {
    const answer = await askMistral(trimmed);
    loadingBubble.remove();
    appendChatBubbleWithSpeak(answer, "assistant");
    speakText(answer);
  } catch (err) {
    loadingBubble.remove();
    const errMsg = `Couldn't reach the assistant — ${err.message || "try again."}`;
    appendChatBubbleWithSpeak(errMsg, "error");
  }
}

// ---- Speech Recognition ----
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const micBtn = document.getElementById("micBtn");
let startListening = () => {}; // reassigned below if the browser supports STT

if (!SpeechRecognition) {
  if (micBtn) {
    micBtn.title = "Voice input not supported in this browser";
    micBtn.style.opacity = "0.35";
    micBtn.style.cursor = "not-allowed";
  }
} else {
  const recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  let isListening = false;
  let finalTranscript = "";

  startListening = function () {
    if (isListening) { recognition.stop(); return; }
    stopSpeaking();
    finalTranscript = "";
    // Voice language is independent of the site's display language.
    // If we've heard the user speak before (or they picked one manually),
    // use that; otherwise leave `lang` unset so the browser uses its own
    // default (usually the OS/browser locale) for the first utterance.
    if (voiceLanguage) {
      recognition.lang = SPEECH_LOCALE[voiceLanguage] || voiceLanguage;
    } else {
      recognition.lang = "";
    }
    recognition.start();
  };

  recognition.onstart = () => {
    isListening = true;
    micBtn.classList.add("listening");
    micBtn.classList.remove("processing");
    setVoiceStatus("🎤 Listening…", "listening");
    chatPanel.classList.add("open");
    setOrbState("listening");
    setWaveBar("listening", "Listening…");
  };

  recognition.onresult = e => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalTranscript += t;
      else interim += t;
    }
    if (interim) setVoiceStatus(`🎤 "${interim}"`, "listening");
  };

  recognition.onend = async () => {
    isListening = false;
    micBtn.classList.remove("listening");
    if (finalTranscript.trim()) {
      micBtn.classList.add("processing");
      setOrbState("thinking");
      setWaveBar("thinking", "Thinking…");
      await handleVoiceTranscript(finalTranscript);
      micBtn.classList.remove("processing");
      setOrbState("idle");
      setWaveBar(null);
    } else {
      setOrbState("idle");
      setWaveBar(null);
      setVoiceStatus("No speech detected — try again", "error");
    }
  };

  recognition.onerror = e => {
    isListening = false;
    micBtn.classList.remove("listening", "processing");
    setOrbState("idle");
    setWaveBar(null);
    const msgs = {
      "not-allowed": "Microphone access denied — allow it in your browser settings.",
      "no-speech": "No speech detected — tap the mic and speak clearly.",
      "network": "Network error during recognition.",
    };
    setVoiceStatus(msgs[e.error] || `Voice error: ${e.error}`, "error");
    console.warn("Speech recognition error:", e.error);
  };

  micBtn.addEventListener("click", startListening);

  // Keyboard shortcut: hold Space to talk when chat is open
  let spaceHeld = false;
  document.addEventListener("keydown", e => {
    if (e.code === "Space" && e.target === document.body && chatPanel.classList.contains("open") && !spaceHeld) {
      spaceHeld = true;
      if (!isListening) startListening();
    }
  });
  document.addEventListener("keyup", e => {
    if (e.code === "Space") {
      spaceHeld = false;
      if (isListening) recognition.stop();
    }
  });
}

// ---- Patch chatForm to use the speak-button-aware appendBubble ----
// Re-attach with override so submit also uses our patched version
chatForm.removeEventListener("submit", chatForm._voiceSubmitHandler);
chatForm._voiceSubmitHandler = async e => {
  e.preventDefault();
  const question = chatInput.value.trim();
  if (!question) return;
  chatInput.value = "";
  appendChatBubbleWithSpeak(question, "user");

  if (!settings.mistralEnabled || !settings.mistralKey) {
    appendChatBubbleWithSpeak("Add and enable a Groq API key in Settings → AI Weather Assistant to use chat.", "error");
    return;
  }

  const loadingBubble = _origAppendBubble("Thinking…", "loading");
  try {
    const answer = await askMistral(question);
    loadingBubble.remove();
    appendChatBubbleWithSpeak(answer, "assistant");
  } catch (err) {
    console.error(err);
    loadingBubble.remove();
    appendChatBubbleWithSpeak(`Couldn't reach Groq — ${err.message || "check your API key and try again."}`, "error");
  }
};
chatForm.addEventListener("submit", chatForm._voiceSubmitHandler);


// ============================================================
//  ORB + WAVE BAR ANIMATION (Gemini-style)
// ============================================================

const chatWaveBar  = document.getElementById("chatWaveBar");
const chatWaveLabel = document.getElementById("chatWaveLabel");
const chatOrbCanvas = document.getElementById("chatOrbCanvas");
const chatOrbStateEl = document.getElementById("chatOrbState");

// ── Wave bar control ──
function setWaveBar(mode, label = "") {
  if (!chatWaveBar) return;
  chatWaveBar.classList.remove("visible", "listening", "speaking", "thinking");
  if (mode) {
    chatWaveBar.classList.add("visible", mode);
    if (chatWaveLabel) chatWaveLabel.textContent = label;
  }
}

// ── Orb canvas (Gemini fluid gradient blob) ──
let orbAnimFrame = null;
let orbPhase = 0;
let orbMode = "idle"; // idle | listening | thinking | speaking

const ORB_COLORS = {
  idle:      { a: "#1a7fd4", b: "#0d4b8a", c: "#4fb8ff" },
  listening: { a: "#22c55e", b: "#16a34a", c: "#4ade80" },
  thinking:  { a: "#f59e0b", b: "#d97706", c: "#fcd34d" },
  speaking:  { a: "#a78bfa", b: "#7c3aed", c: "#c4b5fd" },
};

function setOrbState(mode) {
  if (mode !== orbMode) orbPhase = 0;
  orbMode = mode;
  if (chatOrbStateEl) {
    chatOrbStateEl.textContent = { idle:"AI", listening:"👂", thinking:"💭", speaking:"🔊" }[mode] || "AI";
  }
  if (!orbAnimFrame) animateOrb();
}

function animateOrb() {
  if (!chatOrbCanvas) return;
  const ctx = chatOrbCanvas.getContext("2d");
  const W = chatOrbCanvas.width;
  const H = chatOrbCanvas.height;
  const cx = W / 2, cy = H / 2;
  const colors = ORB_COLORS[orbMode] || ORB_COLORS.idle;
  const speed = { idle: 0.012, listening: 0.045, thinking: 0.025, speaking: 0.06 }[orbMode] || 0.015;

  orbPhase += speed;

  ctx.clearRect(0, 0, W, H);

  // Draw animated blob using multiple bezier layers
  const R = 22;
  const wobble = orbMode === "idle" ? 2 : orbMode === "listening" ? 8 : orbMode === "speaking" ? 10 : 5;

  function blobPath(phase, r, wob) {
    ctx.beginPath();
    const pts = 6;
    for (let i = 0; i <= pts; i++) {
      const angle = (i / pts) * Math.PI * 2 + phase;
      const rad = r + Math.sin(angle * 3 + phase * 2) * wob;
      const x = cx + Math.cos(angle) * rad;
      const y = cy + Math.sin(angle) * rad;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  // Outer glow
  const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, R + wobble + 4);
  grd.addColorStop(0, colors.c + "cc");
  grd.addColorStop(0.6, colors.a + "99");
  grd.addColorStop(1, colors.b + "00");
  blobPath(orbPhase, R + wobble + 4, wobble * 0.5);
  ctx.fillStyle = grd;
  ctx.fill();

  // Core blob
  const grd2 = ctx.createRadialGradient(cx - 5, cy - 5, 2, cx, cy, R);
  grd2.addColorStop(0, colors.c);
  grd2.addColorStop(0.5, colors.a);
  grd2.addColorStop(1, colors.b);
  blobPath(orbPhase * 1.3, R, wobble);
  ctx.fillStyle = grd2;
  ctx.fill();

  // Shimmer highlight
  blobPath(orbPhase * 0.7, R * 0.45, wobble * 0.3);
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  ctx.fill();

  // Stop animating when idle after a while (save CPU)
  if (orbMode === "idle" && orbPhase > 20) {
    orbAnimFrame = null;
    // Draw one final clean circle
    ctx.clearRect(0, 0, W, H);
    const g = ctx.createRadialGradient(cx - 5, cy - 5, 2, cx, cy, R);
    g.addColorStop(0, ORB_COLORS.idle.c);
    g.addColorStop(0.6, ORB_COLORS.idle.a);
    g.addColorStop(1, ORB_COLORS.idle.b);
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    return;
  }

  orbAnimFrame = requestAnimationFrame(animateOrb);
}

// Kick off idle orb on load
setOrbState("idle");
