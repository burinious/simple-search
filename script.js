const searchForm = document.getElementById("search-form");
const searchInput = document.getElementById("search-input");
const clearButton = document.getElementById("clear-button");
const clearHistoryButton = document.getElementById("clear-history-button");
const uploadInput = document.getElementById("upload-input");
const uploadStatus = document.getElementById("upload-status");
const resultsContainer = document.getElementById("results");
const resultsMeta = document.getElementById("results-meta");
const loadingIndicator = document.getElementById("loading-indicator");
const loadingText = document.getElementById("loading-text");
const quickSearches = document.getElementById("quick-searches");
const searchHistory = document.getElementById("search-history");
const recordCount = document.getElementById("record-count");

let searchIndex = [];
let hasLoadedIndex = false;
const recordCache = new Map();
let jsonLoaderFrame = null;
const HISTORY_STORAGE_KEY = "simple-student-search-history";
const HISTORY_LIMIT = 6;
const MAX_VISIBLE_RESULTS = 12;

const studentDetailFields = [
  ["Full Name", "FullName"],
  ["Matric Number", "MatricNo"],
  ["First Name", "FirstName"],
  ["Middle Name", "Middlename"],
  ["Surname", "Surname"],
  ["Programme", "CourseOfStudy"],
  ["Class of Degree", "ClassOfDegree"],
  ["Date of Birth", "DateOfBirth"],
  ["Date of Graduation", "DateOfGraduation"],
  ["Phone Number", "GSMNo"],
  ["State of Origin", "StateOfOrigin"],
  ["Status", "Status"],
  ["Gender", "Gender"],
  ["Marital Status", "MaritalStatus"],
  ["JAMB Reg Number", "JambRegNo"],
  ["Military Status", "IsMilitary"],
  ["Study Mode", "StudyMode"]
];

document.addEventListener("DOMContentLoaded", initializeApp);
searchForm.addEventListener("submit", handleSearch);
clearButton.addEventListener("click", resetSearch);
clearHistoryButton.addEventListener("click", clearSearchHistory);
uploadInput.addEventListener("change", handleUpload);
quickSearches.addEventListener("click", handleStoredQueryClick);
searchHistory.addEventListener("click", handleStoredQueryClick);
document.addEventListener("keydown", handleGlobalShortcuts);

function initializeApp() {
  setLoading(false);
  renderEmptyState("Enter a matric number or student name, or upload a JSON file.");
  renderSearchHistory(loadSearchHistory());
  renderQuickSearches([]);
  updateRecordCount();
  void preloadSearchIndex();
}

async function handleSearch(event) {
  event?.preventDefault();
  await submitSearch(searchInput.value);
}

function resetSearch() {
  searchInput.value = "";
  hideResultsMeta();
  renderEmptyState("Enter a matric number or student name, or upload a JSON file.");
  searchInput.focus();
}

async function submitSearch(rawQuery) {
  const query = String(rawQuery || "").trim();

  if (!query) {
    resetSearch();
    return;
  }

  setLoading(true, hasLoadedIndex ? "Searching records..." : "Loading search index...");
  toggleSearchState(true);

  try {
    await ensureSearchIndexLoaded();
  } catch (error) {
    renderMessage(
      "Record data could not be loaded. Ensure the JSON files are in the same folder as index.html."
    );
    console.error(error);
    setLoading(false);
    toggleSearchState(false);
    return;
  }

  saveSearchToHistory(query);
  loadingText.textContent = "Searching records...";
  await delay(160);

  const matches = findIndexMatches(query);

  if (matches.length === 0) {
    renderMessage(
      "Record not found. You may not have submitted the form or your data is under review."
    );
    showResultsMeta(`No records found for "${query}".`);
    setLoading(false);
    toggleSearchState(false);
    return;
  }

  loadingText.textContent = "Loading matched records...";

  try {
    const visibleMatches = matches.slice(0, MAX_VISIBLE_RESULTS);
    const matchedRecords = await loadMatchedRecords(visibleMatches);
    renderSearchResults(matchedRecords, query, matches.length);
  } catch (error) {
    renderMessage(
      "Matched records could not be loaded. Ensure the student record files are available."
    );
    hideResultsMeta();
    console.error(error);
  } finally {
    setLoading(false);
    toggleSearchState(false);
  }
}

async function loadSearchIndex() {
  const data = await loadJsonFile("search-index.json");
  return normalizeSearchIndex(data);
}

async function loadMatchedRecords(matches) {
  const records = [];

  for (const match of matches) {
    if (recordCache.has(match.RecordFile)) {
      records.push(recordCache.get(match.RecordFile));
      continue;
    }

    const record = await loadJsonFile(match.RecordFile);
    const normalizedRecord = normalizeStudentRecord(record);
    recordCache.set(match.RecordFile, normalizedRecord);
    records.push(normalizedRecord);
  }

  return records;
}

async function loadJsonFile(path) {
  const loaders = [
    () => loadWithFetch(path),
    () => loadWithXhr(path),
    () => loadWithFrame(path)
  ];
  let lastError;

  for (const loader of loaders) {
    try {
      return await loader();
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`Unable to load ${path}.`);
}

async function loadWithFetch(path) {
  const response = await fetch(path, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`Fetch failed with status ${response.status}.`);
  }

  return response.json();
}

function loadWithXhr(path) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("GET", path, true);
    request.overrideMimeType("application/json");

    request.onload = () => {
      if (request.status === 0 || (request.status >= 200 && request.status < 300)) {
        try {
          resolve(JSON.parse(request.responseText));
        } catch (error) {
          reject(error);
        }
        return;
      }

      reject(new Error(`XHR failed with status ${request.status}.`));
    };

    request.onerror = () => reject(new Error(`XHR could not load ${path}.`));
    request.send();
  });
}

function loadWithFrame(path) {
  return new Promise((resolve, reject) => {
    const loaderFrame = getJsonLoaderFrame();

    const parseFrameContent = () => {
      try {
        const frameDocument = loaderFrame.contentDocument || loaderFrame.contentWindow?.document;
        const rawText =
          frameDocument?.body?.textContent?.trim() ||
          frameDocument?.documentElement?.textContent?.trim() ||
          "";

        if (!rawText) {
          reject(new Error("Iframe returned empty record data."));
          return;
        }

        resolve(JSON.parse(rawText));
      } catch (error) {
        reject(error);
      }
    };

    const timeoutId = window.setTimeout(() => {
      loaderFrame.removeEventListener("load", onLoad);
      reject(new Error("Iframe loading timed out."));
    }, 4000);

    const onLoad = () => {
      window.clearTimeout(timeoutId);
      parseFrameContent();
    };

    loaderFrame.addEventListener("load", onLoad, { once: true });
    loaderFrame.src = path;
  });
}

function normalizeSearchIndex(data) {
  if (!Array.isArray(data)) {
    throw new Error("search-index.json must contain an array of record objects.");
  }

  return data.map((student) => {
    const normalizedStudent = {
      MatricNo: String(student.MatricNo || "").trim(),
      FirstName: String(student.FirstName || "").trim(),
      Middlename: String(student.Middlename || "").trim(),
      Surname: String(student.Surname || "").trim(),
      FullName: String(student.FullName || "").trim(),
      RecordFile: String(student.RecordFile || "").trim()
    };

    if (!normalizedStudent.RecordFile) {
      throw new Error("A search index record is missing its RecordFile path.");
    }

    return normalizedStudent;
  });
}

function normalizeStudentRecord(student) {
  const normalizedStudent = {};

  studentDetailFields.forEach(([, key]) => {
    if (key === "FullName") {
      return;
    }

    normalizedStudent[key] = String(student[key] || "").trim();
  });

  return normalizedStudent;
}

function findIndexMatches(query) {
  const normalizedQuery = normalizeText(query);

  const exactMatricMatches = searchIndex.filter(
    (student) => normalizeText(student.MatricNo) === normalizedQuery
  );

  if (exactMatricMatches.length > 0) {
    return exactMatricMatches;
  }

  return searchIndex
    .map((student) => ({
      student,
      score: getMatchScore(student, normalizedQuery)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return getFullName(left.student).localeCompare(getFullName(right.student));
    })
    .map((entry) => entry.student);
}

function renderSearchResults(matches, query, totalMatches) {
  const isMatricSearch = matches.every(
    (student) => normalizeText(student.MatricNo) === normalizeText(query)
  );

  resultsContainer.innerHTML = buildResultCards(matches, {
    badgeText: "Match found",
    query,
    isMatricSearch
  });
  showResultsMeta(buildResultsMeta(query, totalMatches, isMatricSearch));
}

function renderEmptyState(message) {
  hideResultsMeta();
  resultsContainer.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
}

function renderMessage(message) {
  hideResultsMeta();
  resultsContainer.innerHTML = `<div class="message-card">${escapeHtml(message)}</div>`;
}

function setLoading(isVisible, text = "Loading...") {
  loadingText.textContent = text;
  loadingIndicator.hidden = !isVisible;
}

function toggleSearchState(isDisabled) {
  const formElements = searchForm.querySelectorAll("input, button");
  formElements.forEach((element) => {
    element.disabled = isDisabled;
  });
  clearHistoryButton.disabled = isDisabled;
}

function getFullName(student) {
  return [student.Surname, student.FirstName, student.Middlename]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(value) {
  return String(value).trim().toLowerCase();
}

function highlightText(text, query) {
  const safeText = escapeHtml(text);
  const trimmedQuery = String(query).trim();

  if (!trimmedQuery) {
    return safeText;
  }

  const escapedQuery = trimmedQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escapedQuery})`, "ig");

  return safeText.replace(regex, "<mark>$1</mark>");
}

function formatDisplayValue(value, query, isMatricSearch, key) {
  const normalizedValue = String(value || "").trim();

  if (!normalizedValue) {
    return "Not available";
  }

  if (isMatricSearch && key !== "MatricNo") {
    return escapeHtml(normalizedValue);
  }

  return highlightText(normalizedValue, query);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

async function handleUpload(event) {
  const [file] = Array.from(event.target.files || []);

  if (!file) {
    return;
  }

  uploadStatus.textContent = `Selected: ${file.name}`;
  setLoading(true, "Reading uploaded file...");
  toggleSearchState(true);

  try {
    const fileContent = await file.text();
    const parsedContent = JSON.parse(fileContent);
    const uploadedRecords = normalizeUploadedRecords(parsedContent);

    if (!uploadedRecords.length) {
      renderMessage("The uploaded JSON file does not contain any record to display.");
      return;
    }

    const visibleRecords = uploadedRecords.slice(0, MAX_VISIBLE_RESULTS);
    renderUploadedResults(visibleRecords, file.name, uploadedRecords.length);
  } catch (error) {
    renderMessage("The uploaded file could not be read. Upload a valid JSON file.");
    console.error(error);
  } finally {
    setLoading(false);
    toggleSearchState(false);
    uploadInput.value = "";
  }
}

async function preloadSearchIndex() {
  try {
    await ensureSearchIndexLoaded();
  } catch (error) {
    console.error(error);
  }
}

async function ensureSearchIndexLoaded() {
  if (hasLoadedIndex) {
    return searchIndex;
  }

  searchIndex = await loadSearchIndex();
  hasLoadedIndex = true;
  updateRecordCount(searchIndex.length);
  renderQuickSearches(buildQuickSearchExamples(searchIndex));
  return searchIndex;
}

function normalizeUploadedRecords(data) {
  const rawRecords = Array.isArray(data) ? data : [data];

  return rawRecords
    .filter((record) => record && typeof record === "object" && !Array.isArray(record))
    .map((record) => normalizeStudentRecord(record));
}

function getMatchScore(student, normalizedQuery) {
  const matricNo = normalizeText(student.MatricNo);
  const surname = normalizeText(student.Surname);
  const fullName = normalizeText(student.FullName || getFullName(student));
  const nameParts = [student.FirstName, student.Middlename, student.Surname]
    .map(normalizeText)
    .filter(Boolean);

  let score = 0;

  if (fullName === normalizedQuery) {
    score = 130;
  } else if (surname === normalizedQuery || nameParts.some((part) => part === normalizedQuery)) {
    score = 118;
  } else if (fullName.startsWith(normalizedQuery)) {
    score = 104;
  } else if (surname.startsWith(normalizedQuery) || nameParts.some((part) => part.startsWith(normalizedQuery))) {
    score = 96;
  } else if (matricNo.startsWith(normalizedQuery)) {
    score = 88;
  } else if (fullName.includes(` ${normalizedQuery}`)) {
    score = 82;
  } else if (fullName.includes(normalizedQuery) || surname.includes(normalizedQuery)) {
    score = 74;
  } else if (matricNo.includes(normalizedQuery)) {
    score = 64;
  }

  return score;
}

function buildResultsMeta(query, totalMatches, isMatricSearch) {
  if (isMatricSearch) {
    return `Exact matric match for "${query}".`;
  }

  if (totalMatches > MAX_VISIBLE_RESULTS) {
    return `Showing ${MAX_VISIBLE_RESULTS} of ${totalMatches} results for "${query}". Refine the query for fewer cards.`;
  }

  return `${totalMatches} result${totalMatches === 1 ? "" : "s"} for "${query}".`;
}

function buildUploadMeta(fileName, totalRecords) {
  if (totalRecords > MAX_VISIBLE_RESULTS) {
    return `Uploaded ${fileName}. Showing ${MAX_VISIBLE_RESULTS} of ${totalRecords} records from the file.`;
  }

  return `Uploaded ${fileName}. ${totalRecords} record${totalRecords === 1 ? "" : "s"} loaded from the file.`;
}

function showResultsMeta(message) {
  resultsMeta.textContent = message;
  resultsMeta.hidden = false;
}

function hideResultsMeta() {
  resultsMeta.hidden = true;
  resultsMeta.textContent = "";
}

function updateRecordCount(total = null) {
  recordCount.textContent = total ? `${total} records` : "Index pending";
}

function buildQuickSearchExamples(index) {
  const examples = [];
  const seen = new Set();

  for (const student of index) {
    const candidates = [
      student.MatricNo,
      student.FirstName,
      student.Surname,
      student.FullName || getFullName(student)
    ];

    for (const candidate of candidates) {
      const query = String(candidate || "").trim();
      const normalizedQuery = normalizeText(query);

      if (!query || seen.has(normalizedQuery) || query.length > 22) {
        continue;
      }

      seen.add(normalizedQuery);
      examples.push(query);

      if (examples.length === 5) {
        return examples;
      }
    }
  }

  return examples;
}

function renderQuickSearches(examples) {
  if (!examples.length) {
    quickSearches.innerHTML = "";
    return;
  }

  quickSearches.innerHTML = examples
    .map(
      (example) =>
        `<button type="button" class="chip" data-query="${escapeHtml(example)}">${escapeHtml(example)}</button>`
    )
    .join("");
}

function renderUploadedResults(records, fileName, totalRecords) {
  resultsContainer.innerHTML = buildResultCards(records, {
    badgeText: "Uploaded file",
    query: "",
    isMatricSearch: true
  });
  showResultsMeta(buildUploadMeta(fileName, totalRecords));
}

function buildResultCards(matches, options = {}) {
  const {
    badgeText = "Match found",
    query = "",
    isMatricSearch = false
  } = options;

  return matches
    .map((student) => {
      const detailsMarkup = studentDetailFields
        .map(([label, key]) => {
          const rawValue = key === "FullName" ? getFullName(student) : student[key];
          const formattedValue = formatDisplayValue(rawValue, query, isMatricSearch, key);

          return `
            <div>
              <span class="label">${escapeHtml(label)}</span>
              <p class="value${rawValue ? "" : " is-empty"}">${formattedValue}</p>
            </div>
          `;
        })
        .join("");

      return `
        <article class="result-card is-highlighted">
          <div class="result-header">
            <h2 class="result-title">${escapeHtml(getFullName(student) || "Uploaded record")}</h2>
            <span class="badge">${escapeHtml(badgeText)}</span>
          </div>
          <div class="result-grid">
            ${detailsMarkup}
          </div>
        </article>
      `;
    })
    .join("");
}

function handleStoredQueryClick(event) {
  const button = event.target.closest("button[data-query]");

  if (!button) {
    return;
  }

  const query = button.dataset.query || "";
  searchInput.value = query;
  searchInput.focus();
  void submitSearch(query);
}

function handleGlobalShortcuts(event) {
  if (event.key === "/" && document.activeElement !== searchInput) {
    event.preventDefault();
    searchInput.focus();
    searchInput.select();
    return;
  }

  if (event.key === "Escape" && document.activeElement === searchInput) {
    resetSearch();
  }
}

function loadSearchHistory() {
  try {
    const rawHistory = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    const parsedHistory = JSON.parse(rawHistory || "[]");
    return Array.isArray(parsedHistory) ? parsedHistory.filter(Boolean).slice(0, HISTORY_LIMIT) : [];
  } catch (error) {
    console.error(error);
    return [];
  }
}

function saveSearchToHistory(query) {
  const trimmedQuery = String(query || "").trim();

  if (!trimmedQuery) {
    return;
  }

  const history = loadSearchHistory().filter(
    (entry) => normalizeText(entry) !== normalizeText(trimmedQuery)
  );

  history.unshift(trimmedQuery);
  const nextHistory = history.slice(0, HISTORY_LIMIT);

  try {
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(nextHistory));
  } catch (error) {
    console.error(error);
  }

  renderSearchHistory(nextHistory);
}

function clearSearchHistory() {
  try {
    window.localStorage.removeItem(HISTORY_STORAGE_KEY);
  } catch (error) {
    console.error(error);
  }

  renderSearchHistory([]);
}

function renderSearchHistory(history) {
  if (!history.length) {
    searchHistory.innerHTML = `<p class="history-empty">Your recent searches will appear here.</p>`;
    clearHistoryButton.hidden = true;
    return;
  }

  searchHistory.innerHTML = history
    .map(
      (item) =>
        `<button type="button" class="history-chip" data-query="${escapeHtml(item)}">${escapeHtml(item)}</button>`
    )
    .join("");

  clearHistoryButton.hidden = false;
}

function getJsonLoaderFrame() {
  if (jsonLoaderFrame) {
    return jsonLoaderFrame;
  }

  jsonLoaderFrame = document.createElement("iframe");
  jsonLoaderFrame.hidden = true;
  jsonLoaderFrame.title = "JSON loader";
  jsonLoaderFrame.src = "about:blank";
  document.body.appendChild(jsonLoaderFrame);
  return jsonLoaderFrame;
}
