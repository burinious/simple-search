const searchForm = document.getElementById("search-form");
const searchInput = document.getElementById("search-input");
const clearButton = document.getElementById("clear-button");
const resultsContainer = document.getElementById("results");
const loadingIndicator = document.getElementById("loading-indicator");
const loadingText = document.getElementById("loading-text");

let searchIndex = [];
let hasLoadedIndex = false;
const recordCache = new Map();
let jsonLoaderFrame = null;

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

function initializeApp() {
  setLoading(false);
  renderEmptyState("Enter a matric number or student name to begin.");
}

async function handleSearch(event) {
  event.preventDefault();

  const query = searchInput.value.trim();

  if (!query) {
    renderEmptyState("Enter a matric number or student name to begin.");
    searchInput.focus();
    return;
  }

  setLoading(true, hasLoadedIndex ? "Searching records..." : "Loading search index...");
  toggleSearchState(true);

  try {
    if (!hasLoadedIndex) {
      searchIndex = await loadSearchIndex();
      hasLoadedIndex = true;
    }
  } catch (error) {
    renderMessage(
      "Student data could not be loaded. Ensure the JSON files are in the same folder as index.html."
    );
    console.error(error);
    setLoading(false);
    toggleSearchState(false);
    return;
  }

  loadingText.textContent = "Searching records...";
  await delay(250);

  const matches = findIndexMatches(query);

  if (matches.length === 0) {
    renderMessage(
      "Record not found. You may not have submitted the form or your data is under review."
    );
    setLoading(false);
    toggleSearchState(false);
    return;
  }

  loadingText.textContent = "Loading matched records...";

  try {
    const matchedRecords = await loadMatchedRecords(matches);
    renderResults(matchedRecords, query);
  } catch (error) {
    renderMessage(
      "Matched records could not be loaded. Ensure the student record files are available."
    );
    console.error(error);
  } finally {
    setLoading(false);
    toggleSearchState(false);
  }
}

function resetSearch() {
  searchInput.value = "";
  renderEmptyState("Enter a matric number or student name to begin.");
  searchInput.focus();
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
          reject(new Error("Iframe returned empty student data."));
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
    throw new Error("search-index.json must contain an array of student objects.");
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

  return searchIndex.filter((student) => {
    const fullName = student.FullName || getFullName(student);
    const surname = student.Surname;
    const searchableName = [student.FirstName, student.Middlename, student.Surname, fullName]
      .join(" ")
      .trim();

    return (
      normalizeText(searchableName).includes(normalizedQuery) ||
      normalizeText(surname).includes(normalizedQuery) ||
      normalizeText(fullName).includes(normalizedQuery)
    );
  });
}

function renderResults(matches, query) {
  const isMatricSearch = matches.every(
    (student) => normalizeText(student.MatricNo) === normalizeText(query)
  );

  const cards = matches
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
            <h2 class="result-title">${escapeHtml(getFullName(student))}</h2>
            <span class="badge">Match found</span>
          </div>
          <div class="result-grid">
            ${detailsMarkup}
          </div>
        </article>
      `;
    })
    .join("");

  resultsContainer.innerHTML = cards;
}

function renderEmptyState(message) {
  resultsContainer.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
}

function renderMessage(message) {
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
