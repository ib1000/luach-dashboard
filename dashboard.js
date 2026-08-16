"use strict";

/*
 * Luach Dashboard - browser-only version
 * Ported from the original Perl dashboard logic.
 * No Linux, Perl, Python, or local web server is required at runtime.
 */

const DEFAULT_LOCATION = {
  name: "Toronto, Ontario, Canada",
  latitude: 43.6532,
  longitude: -79.3832,
  timezone: "America/Toronto",
  countryCode: "CA",
};

const LOCATION_STORAGE_KEY = "luach-dashboard-location-v1";

function loadSavedLocation() {
  try {
    const saved = JSON.parse(localStorage.getItem(LOCATION_STORAGE_KEY) || "null");
    if (saved && Number.isFinite(Number(saved.latitude)) && Number.isFinite(Number(saved.longitude)) && saved.timezone) {
      return {
        name: String(saved.name || "Selected location"),
        latitude: Number(saved.latitude),
        longitude: Number(saved.longitude),
        timezone: String(saved.timezone),
        countryCode: String(saved.countryCode || "").toUpperCase(),
      };
    }
  } catch (error) {
    console.warn("Unable to read saved location", error);
  }
  return { ...DEFAULT_LOCATION };
}

const SAVED_LOCATION = loadSavedLocation();
const CONFIG = {
  ...SAVED_LOCATION,
  refreshCushionMs: 3000,
  retryAfterErrorMs: 60000,
};

const HEB = "https://www.hebcal.com";
let refreshTimer = null;
let hebrewDateBoundaryTimer = null;
let lastData = null;

const $ = (id) => document.getElementById(id);

function datePartsInZone(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CONFIG.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const out = {};
  for (const p of parts) if (p.type !== "literal") out[p.type] = p.value;
  return {
    year: Number(out.year), month: Number(out.month), day: Number(out.day),
    hour: Number(out.hour), minute: Number(out.minute), second: Number(out.second),
  };
}

function ymd(parts) {
  return `${parts.year}-${String(parts.month).padStart(2,"0")}-${String(parts.day).padStart(2,"0")}`;
}

function addDays(iso, days) {
  const [y,m,d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days, 12, 0, 0));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,"0")}-${String(dt.getUTCDate()).padStart(2,"0")}`;
}

function perlWday(iso) {
  const [y,m,d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y,m-1,d,12)).getUTCDay() + 1; // Sunday=1 ... Saturday=7
}

function daysBetween(a, b) {
  const [ay,am,ad] = a.split("-").map(Number);
  const [by,bm,bd] = b.split("-").map(Number);
  return Math.floor((Date.UTC(by,bm-1,bd) - Date.UTC(ay,am-1,ad))/86400000);
}

function humanDate(iso, opts = {}) {
  const [y,m,d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y,m-1,d,12));
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: opts.short ? "short" : "long",
    day: "numeric",
    year: opts.year === false ? undefined : "numeric",
    weekday: opts.weekday ? "long" : undefined,
  }).format(dt);
}

function dayName(iso) {
  const [y,m,d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {weekday:"long", timeZone:"UTC"})
    .format(new Date(Date.UTC(y,m-1,d,12)));
}


function parseHebrewDate(value) {
  const text = String(value || "");
  const m = text.match(/(\d+)\s+(Nisan|Iyyar|Sivan|Tamuz|Tammuz|Av|Elul|Tishrei|Cheshvan|Kislev|Tevet|Shvat|Shevat|Adar(?:\s+I{1,2})?)/i);
  return m ? { day: Number(m[1]), month: m[2] } : { day: 0, month: "" };
}

function hebrewDateForGregorianDay(items, day) {
  for (const item of items || []) {
    if (String(item.date || "").slice(0, 10) !== day) continue;
    if (item.hdate) return String(item.hdate);
    if (/^hebdate$/i.test(String(item.category || "")) && item.title_orig) return String(item.title_orig);
    if (/^hebdate$/i.test(String(item.category || "")) && item.title) return String(item.title);
  }
  return "";
}

function usesShortenedKabbalatShabbat(title, category = "") {
  // Only true Yom Tov / Chol HaMoed events should shorten Kabbalat Shabbat.
  // Avoid substring false-positives such as "Rosh Hashana LaBehemot".
  const t = String(title || "").trim();
  const c = String(category || "").toLowerCase();
  if (c !== "holiday") return false;
  if (/Rosh Hashana LaBehemot/i.test(t)) return false;
  return /Chol HaMoed|^Pesach(?:\s|$)|^Shavuot(?:\s|$)|^Sukkot(?:\s|$)|^Shemini Atzeret(?:\s|$)|^Simchat Torah(?:\s|$)|^Rosh Hashana(?:\s|$)|^Yom Kippur(?:\s|$)/i.test(t);
}

function hhmmFromIso(value) {
  if (!value) return "--:--";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return "--:--";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CONFIG.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(dt);
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return response.json();
}

function buildUrls(today, lookahead) {
  const loc = `latitude=${encodeURIComponent(CONFIG.latitude)}&longitude=${encodeURIComponent(CONFIG.longitude)}&tzid=${encodeURIComponent(CONFIG.timezone)}`;
  const israel = CONFIG.countryCode === "IL" ? "on" : "off";
  return {
    zmanim: `${HEB}/zmanim?cfg=json&${loc}&date=${today}`,
    zmanimTomorrow: `${HEB}/zmanim?cfg=json&${loc}&date=${addDays(today, 1)}`,
    calendar: `${HEB}/hebcal?v=1&cfg=json&maj=on&min=on&mod=on&nx=on&ss=on&mf=on&c=on&F=on&d=on&b=on&molad=on&mvch=on&i=${israel}&${loc}&start=${today}&end=${lookahead}`,
    shabbat: `${HEB}/shabbat?cfg=json&${loc}&i=${israel}`,
  };
}

async function calculateDashboard() {
  const now = new Date();
  const p = datePartsInZone(now);
  const today = ymd(p);
  const tomorrow = addDays(today, 1);
  const lookahead = addDays(today, 30);
  const wday = perlWday(today);

  const urls = buildUrls(today, lookahead);
  const [zmanimData, zmanimTomorrowData, calData, shabbatData] = await Promise.all([
    fetchJson(urls.zmanim), fetchJson(urls.zmanimTomorrow), fetchJson(urls.calendar),
    fetchJson(urls.shabbat),
  ]);

  let hebrewDate = "";
  let dafYomi = "Loading Daf Yomi...";
  const holidaysToday = [];
  let isHoliday = false;

  let tachanunToday = true;
  let tachanunMincha = true;
  let tachanunReason = "Standard Weekday";

  const shachElements = [];
  const minchaElements = [];
  const maarivElements = [];
  let musafDisplay = "";

  let seasonalPhrase = "Morid HaTal";
  let isMevarchim = false;
  let mevarchimTitle = "";
  let moladInfo = "";
  let isBeforeShavuot = false;
  let isBeforeTishaBav = false;

  // Use exactly one parshah cycle: Israel for Israeli locations, Diaspora elsewhere.
  // Never compare or append the other cycle.
  let parshahDisplay = "No Parshah This Week";
  const locationParsha = (shabbatData.items || []).find(i => i.category === "parashat")?.title || "";
  if (locationParsha) parshahDisplay = locationParsha;

  let hasYaalehShach = false, hasYaalehMincha = false, hasYaalehMaariv = false;
  let hasAlHanissimShach = false, hasAlHanissimMincha = false, hasAlHanissimMaariv = false;
  const hallelShach = [], torahShach = [], otherShach = [], extraMincha = [], extraMaar = [];

  const items = calData.items || [];

  // A service uses the weekday Amidah rain/dew blessing only on a weekday.
  // Keep Chol HaMoed as weekday for this purpose; suppress the blessing only
  // on Shabbat or an actual Yom Tov.
  const isActualYomTov = (item, day) => {
    if (String(item?.date || "").slice(0, 10) !== day) return false;
    if (String(item?.category || "") !== "holiday") return false;
    const title = String(item?.title || "");
    if (/Chol HaMoed|Erev|Rosh Hashana LaBehemot/i.test(title)) return false;
    return /^(?:Rosh Hashana|Yom Kippur|Pesach (?:I|II|VII|VIII)|Shavuot (?:I|II)|Sukkot (?:I|II)|Shemini Atzeret|Simchat Torah)(?:$|:)/i.test(title);
  };
  const yomTovToday = items.some(item => isActualYomTov(item, today));
  const yomTovTomorrow = items.some(item => isActualYomTov(item, tomorrow));
  const shabbatToday = wday === 7;
  const shabbatTonight = wday === 6; // Friday-night Ma'ariv belongs to Shabbat.

  // Friday-only Kabbalat Shabbat status. The shortened form is used
  // when the incoming Shabbat coincides with Yom Tov / Chol HaMoed,
  // or when Friday itself is the concluding festival day immediately
  // before Shabbat.
  let kabbalatShabbat = [];
  if (wday === 6) {
    const relevantFestival = items.some(item => {
      const itemDay = String(item.date || "").slice(0, 10);
      if (itemDay !== today && itemDay !== tomorrow) return false;
      return usesShortenedKabbalatShabbat(item.title, item.category);
    });
    kabbalatShabbat = [relevantFestival ? "Shortened Kabbalat Shabbat" : "Full Kabbalat Shabbat"];
  }

  for (const item of items) {
    const itemDate = String(item.date || "");
    const itemDay = itemDate.slice(0,10);
    const title = String(item.title || "");
    const category = String(item.category || "");

    // Original Perl proactive Shabbat scan for upcoming Shavuot / Tisha B'Av.
    if (wday === 7 && itemDay > today) {
      const away = daysBetween(today, itemDay);
      if (away <= 7) {
        if (/Shavuot I/i.test(title)) isBeforeShavuot = true;
        if (/Tish'?a?\s*B'?av/i.test(title)) isBeforeTishaBav = true;
      }
    }

    if (category === "mevarchim" || /Mevarchim/i.test(title)) {
      if (itemDay === today || (wday === 6 && itemDay === tomorrow)) {
        isMevarchim = true;
        mevarchimTitle = title;
      }
    }

    if (category === "molad" || /Molad/i.test(title)) {
      if (itemDay === today || (wday === 6 && itemDay === tomorrow)) {
        let h = 0, m = 0, s = 0;
        let day = "";
        const isoMatch = itemDate.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
        if (isoMatch) {
          h = Number(isoMatch[4]); m = Number(isoMatch[5]); s = Number(isoMatch[6]);
          day = dayName(`${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`);
        } else {
          const tm = title.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
          if (tm) { h = Number(tm[1]); m = Number(tm[2]); s = Number(tm[3] || 0); }
        }
        day ||= dayName(today);
        const chalakim = Math.floor((s * 0.3) + 0.5);
        let monthName = "";
        const mm = title.match(/Molad\s+([A-Za-z\s']+)/i);
        if (mm) monthName = mm[1].replace(/\s*\d+.*$/, "").trim();
        moladInfo = `Molad ${monthName || "New Month"}: ${day}, ${h} hours, ${m} minutes, and ${chalakim} chalakim`;
      }
    }

    if (category === "hebrewDate" && itemDay === today) {
      if (/Cheshvan|Kislev|Tevet|Shvat|Adar/i.test(title)) {
        seasonalPhrase = "Mashiv HaRuach U'Morid HaGeshem";
      }
    }

    // Tomorrow look-ahead.
    if (itemDay === tomorrow) {
      if (/Rosh Chodesh|Chanukah|Purim|Pesach|Shavuot|Sukkot|Rosh Hashana|Yom Kippur|Shushan Purim|Tu Bishvat|Lag BaOmer|Tish'?a?\s*B'?av/i.test(title)) {
        tachanunMincha = false;
      }
      if (/Rosh Chodesh|Pesach|Shavuot|Sukkot|Rosh Hashana|Yom Kippur/i.test(title)) {
        hasYaalehMaariv = true;
      } else if (/Chanukah|Purim/i.test(title)) {
        hasAlHanissimMaariv = true;
      }
    }

    if (itemDay !== today) continue;

    if (item.hdate) hebrewDate = item.hdate;

    if (category === "hebrewDate") {
      hebrewDate = title;
    } else if (category === "dafyomi") {
      dafYomi = title;
    } else if (/Erev Tish'?a?\s*B'?av/i.test(title)) {
      tachanunMincha = false;
      holidaysToday.push(title);
      isHoliday = true;
    } else if (category === "holiday" || category === "roshchodesh") {
      holidaysToday.push(title);
      isHoliday = true;

      if (/Shemini Atzeret/i.test(title)) {
        seasonalPhrase = "Morid HaTal (Shacharit) / Mashiv HaRuach (Musaf)";
      } else if (/Pesach I:/i.test(title)) {
        seasonalPhrase = "Mashiv HaRuach (Shacharit) / Morid HaTal (Musaf)";
      } else if (/Pesach|Shavuot|Sukkot/i.test(title) && !/Sukkot Ch/i.test(title)) {
        seasonalPhrase = "Morid HaTal";
      }

      if (/Rosh Chodesh/i.test(title)) {
        tachanunToday = false; tachanunMincha = false; tachanunReason = "Rosh Chodesh";
        hasYaalehShach = true; hasYaalehMincha = true;
        hallelShach.push("Half Hallel");
        torahShach.push("Torah: 4 Aliyot");
        musafDisplay = "Rosh Chodesh";
      } else if (/Chanukah/i.test(title)) {
        tachanunToday = false; tachanunMincha = false; tachanunReason = "Chanukah";
        hasAlHanissimShach = true; hasAlHanissimMincha = true; hasAlHanissimMaariv = true;
        hallelShach.push("Full Hallel");
        torahShach.push("Torah: 3 Aliyot");
      } else if (/Purim/i.test(title) && !/Katan/i.test(title)) {
        tachanunToday = false; tachanunMincha = false; tachanunReason = "Purim";
        hasAlHanissimShach = true; hasAlHanissimMincha = true; hasAlHanissimMaariv = true;
        torahShach.push("Torah: 3 Aliyot (Exodus)");
        otherShach.push("Megillah Reading");
        extraMaar.push("Megillah Reading");
      } else if (/Fast|Tzom|Asara|Ta'anit|Tish'?a?\s*B'?av/i.test(title)) {
        if (/Tish'?a?\s*B'?av/i.test(title)) {
          tachanunToday = false; tachanunMincha = false; tachanunReason = "Tisha B'Av";
          otherShach.push("Kinnot Reading");
          torahShach.push("Torah: 3 Aliyot");
          extraMincha.push("Torah: 3 Aliyot + Haftarah", "Nachem", "Aneinu");
        } else {
          otherShach.push("Selichot");
          torahShach.push("Torah: 3 Aliyot (Vaychal - Morning)");
          extraMincha.push("Torah: 3 Aliyot (Vaychal - Afternoon) + Haftarah", "Aneinu (and Avinu Malkeinu)");
        }
      } else if (/Pesach|Shavuot|Sukkot|Shemini Atzeret|Simchat Torah/i.test(title)) {
        tachanunToday = false; tachanunMincha = false; tachanunReason = "Yom Tov / Chol HaMoed";
        if (/Chol HaMoed/i.test(title)) {
          hasYaalehShach = true; hasYaalehMincha = true;
        } else {
          otherShach.push("Festival Amidah");
          extraMincha.push("Festival Amidah");
        }
        const hallelType = /Pesach I|Pesach II|Sukkot|Shemini|Simchat/i.test(title) ? "Full Hallel" : "Half Hallel";
        hallelShach.push(hallelType);
        torahShach.push("Special Festival Reading");
        musafDisplay = "Festival";
      }
    }
  }

  if (!hebrewDate && calData.description) {
    hebrewDate = String(calData.description).replace(/^Hebcal\s+/, "");
  }
  hebrewDate ||= "Hebrew Date Unavailable";

  // Original explicit date overrides.
  if (/^8(?:th)?\s+(?:of\s+)?(?:Av|Menachem\s+Av)/i.test(hebrewDate)) {
    tachanunMincha = false;
  } else if (/^9(?:th)?\s+(?:of\s+)?(?:Av|Menachem\s+Av)/i.test(hebrewDate)) {
    tachanunToday = false; tachanunMincha = false; tachanunReason = "Tisha B'Av";
    if (!otherShach.includes("Kinnot Reading")) otherShach.push("Kinnot Reading");
    if (!torahShach.length) torahShach.push("Torah: 3 Aliyot");
    if (!extraMincha.includes("Nachem")) extraMincha.push("Torah: 3 Aliyot + Haftarah", "Nachem", "Aneinu");
  }

  // Friday / Shabbat overrides.
  if (wday === 6) {
    tachanunMincha = false;
  } else if (wday === 7) {
    tachanunToday = false; tachanunMincha = false; tachanunReason = "Shabbat";
    torahShach.push("Torah: 7 Aliyot (Weekly Parshah)");
    if (isBeforeShavuot || isBeforeTishaBav) torahShach.push("Av Harachamim");
    extraMincha.push("Torah: 3 Aliyot (Upcoming Parshah)");
    extraMaar.push("Weekday Amidah (with Atah Chonantanu)");
    musafDisplay = musafDisplay ? `${musafDisplay} + Shabbat` : "Shabbat";
  }

  let shachSeason, musafSeason, minchaSeason, maarivSeason;
  if (seasonalPhrase.includes(" / ")) {
    const parts = seasonalPhrase.split(" / ");
    shachSeason = parts[0].replace(/ \(Shacharit\)/g, "");
    musafSeason = parts[1].replace(/ \(Musaf\)/g, "");
    minchaSeason = musafSeason; maarivSeason = musafSeason;
  } else {
    shachSeason = musafSeason = minchaSeason = maarivSeason = seasonalPhrase;
  }

  // In this dashboard's minhag, Morid HaTal is displayed only in Israel.
  // Mashiv HaRuach remains location-independent.
  if (CONFIG.countryCode !== "IL") {
    if (/Morid HaTal/i.test(shachSeason)) shachSeason = "";
    if (/Morid HaTal/i.test(musafSeason)) musafSeason = "";
    if (/Morid HaTal/i.test(minchaSeason)) minchaSeason = "";
    if (/Morid HaTal/i.test(maarivSeason)) maarivSeason = "";
  }

  // Rain/dew blessing logic, ported from Perl.
  const currentHebrew = parseHebrewDate(hebrewDate);
  let hDay = currentHebrew.day || 1;
  let hMonth = currentHebrew.month || "";

  // Ma'ariv belongs to the Hebrew date that begins this evening. Use the
  // next Gregorian day's Hebcal hdate rather than inferring it from today's
  // displayed Hebrew date. This is especially important on 30 Av, when
  // Ma'ariv is already 1 Elul (the second night of Rosh Chodesh Elul).
  const tomorrowHebrewDate = hebrewDateForGregorianDay(items, tomorrow);
  const tomorrowHebrew = parseHebrewDate(tomorrowHebrewDate);

  let isIsraelRain = false, isDiaspRain = false;
  if (/Kislev|Tevet|Shevat|Adar/i.test(hMonth)) isIsraelRain = true;
  else if (/Cheshvan/i.test(hMonth) && hDay >= 7) isIsraelRain = true;
  else if (/Nisan/i.test(hMonth) && hDay < 15) isIsraelRain = true;

  const leapOffsetYear = (p.year % 4 === 3) ? 1 : 0;
  const transitionDay = 4 + leapOffsetYear;
  if (p.month === 12 && p.day >= transitionDay) isDiaspRain = true;
  else if (p.month < 4) isDiaspRain = true;
  else if (p.month === 4 && /Nisan/i.test(hMonth) && hDay < 15) isDiaspRain = true;

  const israelBlessing = isIsraelRain ? "V'ten Tal U'Matar Livrachah" : "V'ten Berachah";
  const diaspBlessing = isDiaspRain ? "V'ten Tal U'Matar Livrachah" : "V'ten Berachah";
  const rainDew = diaspBlessing === israelBlessing
    ? diaspBlessing
    : `Diaspora: ${diaspBlessing} | Israel: ${israelBlessing}`;

  if (shachSeason) shachElements.push(shachSeason);
  if (!shabbatToday && !yomTovToday) shachElements.push(rainDew);
  if (hasYaalehShach) shachElements.push("Yaaleh Veyavo");
  if (hasAlHanissimShach) shachElements.push("Al HaNissim");
  shachElements.push(...hallelShach, ...otherShach);
  if (!tachanunToday && wday !== 7) shachElements.push("No Tachanun");
  shachElements.push(...torahShach);

  // Psalm 27 (Le'David): from Rosh Chodesh Elul through Shemini Atzeret.
  // Shacharit follows today's Hebrew date. Ma'ariv follows the Hebrew date
  // that begins this evening, so use tomorrowHebrew rather than today's date.
  // Keep Le'David last in each applicable list.
  const isLeDavidDay = /Elul/i.test(hMonth) || (/Tishrei/i.test(hMonth) && hDay <= 22);
  const isLeDavidMaariv =
    /Elul/i.test(tomorrowHebrew.month) ||
    (/Tishrei/i.test(tomorrowHebrew.month) && tomorrowHebrew.day <= 22);
  if (hasYaalehShach && holidaysToday.some(title => /Rosh Chodesh/i.test(title))) {
    shachElements.push("Barchi Nafshi");
  }
  if (isLeDavidDay) shachElements.push("Le'David");

  if (minchaSeason) minchaElements.push(minchaSeason);
  if (!shabbatToday && !yomTovToday) minchaElements.push(rainDew);
  if (hasYaalehMincha) minchaElements.push("Yaaleh Veyavo");
  if (hasAlHanissimMincha) minchaElements.push("Al HaNissim");
  minchaElements.push(...extraMincha);
  if ((!tachanunMincha || !tachanunToday) && wday !== 7) minchaElements.push("No Tachanun");

  if (maarivSeason) maarivElements.push(maarivSeason);
  if (!shabbatTonight && !yomTovTomorrow) maarivElements.push(rainDew);
  if (hasYaalehMaariv) maarivElements.push("Yaaleh Veyavo");
  if (hasAlHanissimMaariv) maarivElements.push("Al HaNissim");
  maarivElements.push(...extraMaar);
  if (isLeDavidMaariv) maarivElements.push("Le'David");

  const tachanunDisplay = !tachanunToday
    ? `No (${tachanunReason})`
    : (!tachanunMincha ? "Yes (Omitted at Mincha)" : "Yes (Standard Weekday)");

  // Candle lighting, including Plag lookup for each relevant day.
  const candleCandidates = items
    .filter(item => item.category === "candles" && String(item.date || "").slice(0,10) >= today)
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")))
    .slice(0, 3);
  const candleLighting = [];
  for (const item of candleCandidates) {
    const m = String(item.date || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) continue;
    const iso = `${m[1]}-${m[2]}-${m[3]}`;
    const latest = `${m[4]}:${m[5]}`;
    const day = dayName(iso);
    const entry = { date: iso, day, text_date: humanDate(iso,{year:false}), title:item.title, latest };
    if (day === "Saturday" || /Yom Tov|Second Day|after/i.test(item.title || "")) {
      entry.type = "not_before";
      entry.not_before = latest;
    } else {
      entry.type = "before_sunset";
      try {
        const z = await fetchJson(`${HEB}/zmanim?cfg=json&latitude=${CONFIG.latitude}&longitude=${CONFIG.longitude}&tzid=${encodeURIComponent(CONFIG.timezone)}&date=${iso}`);
        entry.earliest_plag = hhmmFromIso(z?.times?.plagHaMincha);
      } catch {
        entry.earliest_plag = "--:--";
      }
    }
    candleLighting.push(entry);
  }

  const zmanKeys = ["alotHaShachar","misheyakir","sunrise","sofZmanShmaMGA","sofZmanShma","sofZmanTfilla","chatzot","minchaGedola","minchaKetana","plagHaMincha","sunset","tzeit42min","chatzotNight"];
  const labels = {
    alotHaShachar:"Alot HaShachar (Dawn)", misheyakir:"Misheyakir (Tallit)", sunrise:"Netz Hachamah (Sunrise)",
    sofZmanShmaMGA:"Sof Zman Shma (MGA)", sofZmanShma:"Sof Zman Shma (Gra)", sofZmanTfilla:"Sof Zman Tefillah (Gra)",
    chatzot:"Chatzot (Midday)", minchaGedola:"Mincha Gedolah", minchaKetana:"Mincha Ketanah",
    plagHaMincha:"Plag HaMincha", sunset:"Shkiat HaChamah (Sunset)", tzeit42min:"Tzeit HaKochavim (42m)", chatzotNight:"Chatzot (Midnight)",
  };
  // Calculate the upcoming nighttime Chatzot as the midpoint between
  // today's sunset and tomorrow's sunrise. This avoids ambiguity in the
  // civil-date association of Hebcal's chatzotNight field and guarantees
  // that the displayed midnight belongs to the night that follows today's
  // sunset.
  const sunsetIsoForMidnight = zmanimData.times?.sunset || "";
  const tomorrowSunriseIso = zmanimTomorrowData.times?.sunrise || "";
  let upcomingChatzotNight = "";
  if (sunsetIsoForMidnight && tomorrowSunriseIso) {
    const sunsetMs = new Date(sunsetIsoForMidnight).getTime();
    const sunriseMs = new Date(tomorrowSunriseIso).getTime();
    if (Number.isFinite(sunsetMs) && Number.isFinite(sunriseMs) && sunriseMs > sunsetMs) {
      upcomingChatzotNight = new Date(sunsetMs + ((sunriseMs - sunsetMs) / 2)).toISOString();
    }
  }
  // Fallback only if the midpoint cannot be calculated.
  if (!upcomingChatzotNight) {
    upcomingChatzotNight = zmanimTomorrowData.times?.chatzotNight || zmanimData.times?.chatzotNight || "";
  }

  const zmanim = zmanKeys.map(key => {
    const iso = key === "chatzotNight" ? upcomingChatzotNight : (zmanimData.times?.[key] || "");
    return { key, label:labels[key], time:hhmmFromIso(iso), iso };
  });

  const upcomingEvents = items
    .filter(item => (item.category === "holiday" || item.category === "roshchodesh") && String(item.date || "").slice(0,10) > today && !/Mevarchim|Molad/i.test(item.title || ""))
    .map(item => {
      const iso = String(item.date || "").slice(0,10);
      return { title:item.title, category:item.category, date:iso, text_date:humanDate(iso) };
    });

  const mevarchimNote = (isMevarchim || moladInfo)
    ? `Shabbat Mevarchim (${mevarchimTitle || "Blessing of the New Month"}) occurs ${wday === 6 ? "tomorrow" : "today"}`
    : "";

  return {
    status:"ok",
    updated:{date:today,time:`${String(p.hour).padStart(2,"0")}:${String(p.minute).padStart(2,"0")}`,timezone:CONFIG.timezone,epoch:Date.now()},
    location:{name:CONFIG.name,latitude:CONFIG.latitude,longitude:CONFIG.longitude,timezone:CONFIG.timezone,countryCode:CONFIG.countryCode},
    calendar:{hebrew_date:hebrewDate,hebrew_date_current:hebrewDate,hebrew_date_next:tomorrowHebrewDate,parshah:parshahDisplay,is_holiday:isHoliday,holidays:holidaysToday,tachanun:tachanunDisplay,daf_yomi:dafYomi,shabbat_mevarchim:isMevarchim,mevarchim_title:mevarchimTitle,mevarchim_note:mevarchimNote,molad:moladInfo},
    tefillah:{nusach:"Ashkenaz",shacharit:shachElements,musaf:musafDisplay ? [musafDisplay,musafSeason].filter(Boolean) : [],mincha:minchaElements,kabbalat_shabbat:kabbalatShabbat,maariv:maarivElements},
    candle_lighting:candleLighting,
    zmanim:{ordered:zmanim,by_key:Object.fromEntries(zmanim.map(z=>[z.key,z.time]))},
    upcoming_events:upcomingEvents,
  };
}

function renderFacts(calendar) {
  const rows = [
    ["Parshah", calendar.parshah],
    ["Holiday", calendar.is_holiday ? (calendar.holidays?.join(", ") || "Yes") : "No"],
    ["Tachanun", calendar.tachanun],
    ["Daf Yomi", calendar.daf_yomi],
  ];
  const dl = $("today-facts"); dl.replaceChildren();
  for (const [k,v] of rows) {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v || "—";
    dl.append(dt,dd);
  }
  const note = $("calendar-note");
  const notes = [calendar.mevarchim_note, calendar.molad].filter(Boolean);
  note.hidden = !notes.length; note.textContent = notes.join(" · ");
}

function renderTefillah(t) {
  $("nusach-label").textContent = t.nusach ? `Nusach ${t.nusach}` : "";
  const grid = $("tefillah-grid"); grid.replaceChildren();
  for (const [name,items] of [["Shacharit",t.shacharit],["Musaf",t.musaf],["Mincha",t.mincha],["Kabbalat Shabbat",t.kabbalat_shabbat],["Ma'ariv",t.maariv]]) {
    if (!items?.length) continue;
    const card = document.createElement("article"); card.className="tefillah-card";
    const h3 = document.createElement("h3"); h3.textContent=name;
    const tags = document.createElement("div"); tags.className="tag-list";
    for (const value of items) {
      const span=document.createElement("span");
      span.className=/No Tachanun|Hallel|Torah|Megillah|Kinnot|Selichot|Yaaleh|Al HaNissim|Nachem|Aneinu|Festival Amidah/i.test(value) ? "tag emphasis" : "tag";
      span.textContent=value; tags.append(span);
    }
    card.append(h3,tags); grid.append(card);
  }
}

function renderZmanim(data) {
  const list=$("zmanim-list"); list.replaceChildren();
  const z=data?.ordered || [];
  const now=Date.now();
  // Select the chronologically earliest future zman, independent of where
  // that zman appears in the visual list. This is essential for the final
  // Chatzot (Midnight) row and for Alot HaShachar after midnight.
  let next = -1;
  let nextMs = Infinity;
  z.forEach((item, i) => {
    if (!item.iso) return;
    const ms = new Date(item.iso).getTime();
    if (Number.isFinite(ms) && ms > now && ms < nextMs) {
      nextMs = ms;
      next = i;
    }
  });
  z.forEach((item,i)=>{
    const row=document.createElement("div"); row.className=`zman-row${i===next?" next":""}`;
    const l=document.createElement("span"); l.className="zman-label"; l.textContent=item.label;
    const tm=document.createElement("span"); tm.className="zman-time"; tm.textContent=item.time;
    row.append(l,tm); list.append(row);
  });
}

function renderCandles(entries) {
  const list=$("candle-list"); list.replaceChildren();
  if (!entries?.length) { list.innerHTML='<div class="empty-state">No upcoming candle-lighting events found.</div>'; return; }
  for (const e of entries) {
    const a=document.createElement("article"); a.className="stack-item";
    const title=document.createElement("div"); title.className="stack-item-title"; title.textContent=`${e.day} · ${e.text_date}`;
    const meta=document.createElement("div"); meta.className="stack-item-meta";
    meta.textContent=e.type==="not_before" ? `Not before ${e.not_before} · ${e.title}` : `Earliest (Plag): ${e.earliest_plag} · Latest: ${e.latest} · ${e.title}`;
    a.append(title,meta); list.append(a);
  }
}

function renderEvents(entries) {
  const list=$("event-list"); list.replaceChildren();
  if (!entries?.length) { list.innerHTML='<div class="empty-state">No major events noted for the next 30 days.</div>'; return; }
  for (const e of entries) {
    const a=document.createElement("article"); a.className="event-item";
    const title=document.createElement("div"); title.className="event-title"; title.textContent=e.title;
    const date=document.createElement("div"); date.className="event-date"; date.textContent=e.text_date;
    a.append(title,date); list.append(a);
  }
}

function hebrewDateParts(data) {
  const current = data?.calendar?.hebrew_date_current || data?.calendar?.hebrew_date || "Hebrew Date Unavailable";
  const next = data?.calendar?.hebrew_date_next || "";
  const ordered = data?.zmanim?.ordered || [];
  const sunsetIso = ordered.find(z => z.key === "sunset")?.iso;
  const tzeitIso = ordered.find(z => z.key === "tzeit42min")?.iso;
  const sunset = sunsetIso ? new Date(sunsetIso) : null;
  const tzeit = tzeitIso ? new Date(tzeitIso) : null;
  return {current, next, sunset, tzeit};
}

function setHebrewDateHeading(data, mode = "auto") {
  const {current, next, sunset, tzeit} = hebrewDateParts(data);
  if (!next || !sunset || !tzeit || Number.isNaN(sunset.getTime()) || Number.isNaN(tzeit.getTime())) {
    $("hebrew-date").textContent = current;
    return;
  }

  if (mode === "dual") {
    $("hebrew-date").textContent = `${current} / ${next}`;
    return;
  }

  const now = Date.now();
  if (now >= tzeit.getTime()) {
    $("hebrew-date").textContent = next;
  } else if (now >= sunset.getTime()) {
    $("hebrew-date").textContent = `${current} / ${next}`;
  } else {
    $("hebrew-date").textContent = current;
  }
}

function scheduleHebrewDateBoundary(data) {
  if (hebrewDateBoundaryTimer) clearTimeout(hebrewDateBoundaryTimer);
  hebrewDateBoundaryTimer = null;

  const {next, sunset, tzeit} = hebrewDateParts(data);
  if (!next || !sunset || !tzeit || Number.isNaN(sunset.getTime()) || Number.isNaN(tzeit.getTime())) return;

  const now = Date.now();
  // Before Shkiah, schedule exactly one local display change. No API call is made.
  if (now < sunset.getTime()) {
    hebrewDateBoundaryTimer = setTimeout(() => {
      if (lastData) setHebrewDateHeading(lastData, "dual");
    }, Math.max(0, sunset.getTime() - now));
  }
  // At Tzeit we deliberately do not change the date locally. The scheduled API
  // refresh handles the transition so date-dependent dashboard data changes together.
}

function renderDashboard(data) {
  lastData=data;
  setHebrewDateHeading(data);
  scheduleHebrewDateBoundary(data);
  $("gregorian-date").textContent=humanDate(data.updated.date,{weekday:true});
  $("location-label").textContent=`${CONFIG.name} · ${CONFIG.timezone}`;
  renderFacts(data.calendar); renderTefillah(data.tefillah); renderZmanim(data.zmanim); renderCandles(data.candle_lighting); renderEvents(data.upcoming_events);
  $("error-banner").hidden=true;
  $("status-dot").className="status-dot ok";
  $("update-status").textContent=`Data updated ${data.updated.time}; next refresh scheduled automatically`;
}

function nextRefreshDate(data) {
  const now=Date.now();
  const future=(data.zmanim?.ordered || [])
    // Shkiah is handled locally by scheduleHebrewDateBoundary(); do not call Hebcal just for it.
    .filter(z => z.key !== "sunset")
    .map(z => z.iso ? new Date(z.iso).getTime() : NaN)
    .filter(ms => Number.isFinite(ms) && ms > now)
    .sort((a,b)=>a-b);

  // Compute next civil midnight in the configured timezone as a fallback.
  const today=ymd(datePartsInZone(new Date(now)));
  let midnight=now + 24*3600000;
  for (let t=now+60000; t<=now+26*3600000; t+=60000) {
    if (ymd(datePartsInZone(new Date(t))) !== today) { midnight=t; break; }
  }
  // Prefer the next actual zman. Civil midnight is only a fallback if no
  // usable future zman was returned. This avoids an unnecessary API call at
  // 00:00 while still allowing the next Chatzot and then Alot to drive refreshes.
  return new Date(future[0] ?? midnight);
}

function scheduleNextRefresh(data) {
  if (refreshTimer) clearTimeout(refreshTimer);
  const target=nextRefreshDate(data);
  const delay=Math.max(5000, target.getTime()-Date.now()+CONFIG.refreshCushionMs);
  refreshTimer=setTimeout(refreshDashboard, delay);
  const when=new Intl.DateTimeFormat("en-US", {timeZone:CONFIG.timezone,hour:"numeric",minute:"2-digit",second:"2-digit"}).format(target);
  $("next-refresh").textContent=`Next API refresh: ${when}`;
}


let locationSearchTimer = null;
let locationSearchController = null;

function formatLocationName(result) {
  const parts = [result.name, result.admin1, result.country].filter(Boolean);
  return [...new Set(parts)].join(", ");
}

function setLocationSearchMessage(message, isError = false) {
  const box = $("location-results");
  box.replaceChildren();
  const div = document.createElement("div");
  div.className = isError ? "location-search-message error" : "location-search-message";
  div.textContent = message;
  box.append(div);
}

async function searchLocations(query) {
  const q = String(query || "").trim();
  if (q.length < 2) {
    setLocationSearchMessage("Type at least 2 characters to search for a city or postal code.");
    return;
  }

  if (locationSearchController) locationSearchController.abort();
  locationSearchController = new AbortController();
  setLocationSearchMessage("Searching…");

  try {
    const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
    url.searchParams.set("name", q);
    url.searchParams.set("count", "12");
    url.searchParams.set("language", "en");
    url.searchParams.set("format", "json");

    const response = await fetch(url, { signal: locationSearchController.signal, cache: "no-store" });
    if (!response.ok) throw new Error(`Location search failed (${response.status})`);
    const payload = await response.json();
    const results = (payload.results || []).filter(r =>
      Number.isFinite(Number(r.latitude)) && Number.isFinite(Number(r.longitude)) && r.timezone
    );

    const box = $("location-results");
    box.replaceChildren();
    if (!results.length) {
      setLocationSearchMessage("No matching locations found.");
      return;
    }

    for (const result of results) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "location-result";

      const primary = document.createElement("span");
      primary.className = "location-result-name";
      primary.textContent = formatLocationName(result);

      const secondary = document.createElement("span");
      secondary.className = "location-result-meta";
      secondary.textContent = result.timezone;

      button.append(primary, secondary);
      button.addEventListener("click", () => selectLocation(result));
      box.append(button);
    }
  } catch (error) {
    if (error.name === "AbortError") return;
    console.error(error);
    setLocationSearchMessage("Unable to search locations. Check the Internet connection and try again.", true);
  }
}

function selectLocation(result) {
  const selected = {
    name: formatLocationName(result),
    latitude: Number(result.latitude),
    longitude: Number(result.longitude),
    timezone: String(result.timezone),
    countryCode: String(result.country_code || "").toUpperCase(),
  };

  Object.assign(CONFIG, selected);
  localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify(selected));

  $("location-label").textContent = `${CONFIG.name} · ${CONFIG.timezone}`;
  $("location-dialog").close();
  $("location-search").value = "";
  $("location-results").replaceChildren();

  if (refreshTimer) clearTimeout(refreshTimer);
  if (hebrewDateBoundaryTimer) clearTimeout(hebrewDateBoundaryTimer);
  lastData = null;
  updateClock();
  refreshDashboard();
}

function openLocationDialog() {
  $("current-location").textContent = `${CONFIG.name} · ${CONFIG.timezone}`;
  const dialog = $("location-dialog");
  if (!dialog.open) dialog.showModal();
  setLocationSearchMessage("Search by city name or postal code.");
  setTimeout(() => $("location-search").focus(), 0);
}

function setupLocationControls() {
  $("change-location").addEventListener("click", openLocationDialog);
  $("location-cancel").addEventListener("click", () => $("location-dialog").close());
  $("location-search").addEventListener("input", (event) => {
    clearTimeout(locationSearchTimer);
    const q = event.target.value;
    locationSearchTimer = setTimeout(() => searchLocations(q), 300);
  });
  $("location-search").addEventListener("keydown", (event) => {
    if (event.key === "Escape") $("location-dialog").close();
  });
}

async function refreshDashboard() {
  if (refreshTimer) clearTimeout(refreshTimer);
  $("status-dot").className="status-dot";
  $("update-status").textContent="Updating from Hebcal…";
  try {
    const data=await calculateDashboard();
    renderDashboard(data); scheduleNextRefresh(data);
  } catch (err) {
    console.error(err);
    $("status-dot").className="status-dot bad";
    $("update-status").textContent="Hebcal update failed; retrying in 1 minute";
    const banner=$("error-banner"); banner.hidden=false; banner.textContent=`Unable to update: ${err.message}`;
    refreshTimer=setTimeout(refreshDashboard,CONFIG.retryAfterErrorMs);
  }
}

function updateClock() {
  const now=new Date();
  $("live-clock").textContent=new Intl.DateTimeFormat("en-CA", {timeZone:CONFIG.timezone,hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).format(now);
  if (lastData) {
    renderZmanim(lastData.zmanim);
  }
}

window.addEventListener("load",()=>{
  setupLocationControls();
  $("location-label").textContent=`${CONFIG.name} · ${CONFIG.timezone}`;
  updateClock(); setInterval(updateClock,1000); refreshDashboard();
});
