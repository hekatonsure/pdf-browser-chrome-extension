// Background service worker for PDF viewer
// Copied from Mozilla PDF.js MV3 implementation

"use strict";

const VIEWER_URL = chrome.runtime.getURL('viewer/index.html');

// Use storage.session to ensure DNR rules are registered at least once per session
chrome.storage.session.get({ hasPdfRedirector: false }, async items => {
  if (items?.hasPdfRedirector) {
    return;
  }
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  if (rules.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: rules.map(r => r.id),
    });
  }
  await registerPdfRedirectRule();
  chrome.storage.session.set({ hasPdfRedirector: true });
});

/**
 * Registers declarativeNetRequest rules to redirect PDF requests to the viewer.
 * Based directly on PDF.js implementation.
 */
async function registerPdfRedirectRule() {
  const ACTION_IGNORE_OTHER_RULES = { type: "allow" };

  const ACTION_REDIRECT_TO_VIEWER = {
    type: "redirect",
    redirect: {
      regexSubstitution: VIEWER_URL + "?file=\\0",
    },
  };

  // Rules in order of priority (highest priority rule first).
  const addRules = [
    {
      // Do not redirect for URLs containing pdfjs.action=download.
      condition: {
        urlFilter: "pdfjs.action=download",
        resourceTypes: ["main_frame", "sub_frame"],
      },
      action: ACTION_IGNORE_OTHER_RULES,
    },
    {
      // Redirect local PDF files
      condition: {
        regexFilter: "^file://.*\\.pdf$",
        resourceTypes: ["main_frame", "sub_frame"],
      },
      action: ACTION_REDIRECT_TO_VIEWER,
    },
    {
      // Respect Content-Disposition:attachment in sub_frame
      condition: {
        urlFilter: "*",
        resourceTypes: ["sub_frame"],
        responseHeaders: [
          {
            header: "content-disposition",
            values: ["attachment*"],
          },
        ],
      },
      action: ACTION_IGNORE_OTHER_RULES,
    },
    {
      // Respect Content-Disposition:attachment in main_frame (allow download)
      condition: {
        urlFilter: "*",
        resourceTypes: ["main_frame"],
        responseHeaders: [
          {
            header: "content-disposition",
            values: ["attachment*"],
          },
        ],
      },
      action: ACTION_IGNORE_OTHER_RULES,
    },
    {
      // KEY RULE: Regular http(s) PDF requests based on Content-Type header
      condition: {
        regexFilter: "^.*$",
        excludedRequestMethods: ["post"],
        resourceTypes: ["main_frame", "sub_frame"],
        responseHeaders: [
          {
            header: "content-type",
            values: ["application/pdf", "application/pdf;*"],
          },
        ],
      },
      action: ACTION_REDIRECT_TO_VIEWER,
    },
    {
      // Wrong MIME-type but .pdf in URL
      condition: {
        regexFilter: "^.*\\.pdf\\b.*$",
        excludedRequestMethods: ["post"],
        resourceTypes: ["main_frame", "sub_frame"],
        responseHeaders: [
          {
            header: "content-type",
            values: ["application/octet-stream", "application/octet-stream;*"],
          },
        ],
      },
      action: ACTION_REDIRECT_TO_VIEWER,
    },
    {
      // Wrong MIME-type but .pdf in Content-Disposition
      condition: {
        regexFilter: "^.*$",
        excludedRequestMethods: ["post"],
        resourceTypes: ["main_frame", "sub_frame"],
        responseHeaders: [
          {
            header: "content-disposition",
            values: ["*.pdf", '*.pdf"*', "*.pdf'*"],
          },
        ],
        excludedResponseHeaders: [
          {
            header: "content-type",
            excludedValues: [
              "application/octet-stream",
              "application/octet-stream;*",
            ],
          },
        ],
      },
      action: ACTION_REDIRECT_TO_VIEWER,
    },
  ];

  // Assign IDs and priorities
  for (const [i, rule] of addRules.entries()) {
    rule.id = i + 1;
    rule.priority = addRules.length - i;
  }

  // Try the full ruleset first (header-condition rules require Chrome 128+ /
  // Firefox 128+, which both manifest version-gates already enforce). If a
  // browser rejects the ruleset — e.g. it doesn't accept excludedResponseHeaders
  // or some other condition field — fall back to URL-only matching so .pdf
  // links still work.
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ addRules });
    console.log('PDF Viewer: Registered', addRules.length, 'DNR rules with header conditions');
    return;
  } catch (e) {
    console.warn('PDF Viewer: Header-condition rules rejected, falling back:', e?.message || e);
  }

  const fallbackRules = [
    {
      id: 1,
      priority: 100,
      condition: {
        regexFilter: "^https?://.*\\.pdf(\\?.*)?$",
        resourceTypes: ["main_frame"],
      },
      action: ACTION_REDIRECT_TO_VIEWER,
    },
    {
      id: 2,
      priority: 100,
      condition: {
        regexFilter: "^file://.*\\.pdf$",
        resourceTypes: ["main_frame"],
      },
      action: ACTION_REDIRECT_TO_VIEWER,
    },
  ];
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ addRules: fallbackRules });
    console.log('PDF Viewer: Registered', fallbackRules.length, 'fallback DNR rules');
  } catch (e) {
    console.error('PDF Viewer: Fallback rule registration also failed:', e);
  }
}

function getViewerURL(pdf_url) {
  let hash = "";
  const i = pdf_url.indexOf("#");
  if (i > 0) {
    hash = pdf_url.slice(i);
    pdf_url = pdf_url.slice(0, i);
  }
  return VIEWER_URL + "?file=" + encodeURIComponent(pdf_url) + hash;
}

// Firefox doesn't support DNR responseHeaders conditions, so the fallback rules
// only match URLs literally ending in .pdf. Catch PDFs served at other URLs by
// watching Content-Type via webRequest and navigating the tab to the viewer.
const IS_FIREFOX = typeof navigator !== 'undefined' && /Firefox\//.test(navigator.userAgent);

if (IS_FIREFOX && chrome.webRequest?.onHeadersReceived) {
  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (details.tabId < 0) return;
      if (details.url.startsWith(VIEWER_URL)) return;
      if (details.url.includes('pdfjs.action=download')) return;

      const headers = details.responseHeaders || [];
      const getHeader = (name) =>
        headers.find(h => h.name.toLowerCase() === name)?.value?.toLowerCase() || '';

      const contentDisposition = getHeader('content-disposition');
      if (contentDisposition.startsWith('attachment')) return;

      const contentType = getHeader('content-type');
      const isPdf =
        contentType.startsWith('application/pdf') ||
        (contentType.startsWith('application/octet-stream') && /\.pdf\b/i.test(details.url)) ||
        /\.pdf(["';]|$)/i.test(contentDisposition);

      if (isPdf) {
        chrome.tabs.update(details.tabId, { url: getViewerURL(details.url) });
      }
    },
    { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] },
    ["responseHeaders"]
  );
  console.log('PDF Viewer: Firefox webRequest interceptor registered');
}

// Fallback for file:// URLs when file access not granted (Chrome only).
// Firefox grants file:// access via the <all_urls> host permission, so the
// DNR file:// rule handles it directly and this API is unavailable there.
if (chrome.extension && chrome.extension.isAllowedFileSchemeAccess) {
  chrome.webNavigation.onBeforeNavigate.addListener(
    function (details) {
      if (details.frameId === 0) {
        chrome.extension.isAllowedFileSchemeAccess(function (isAllowedAccess) {
          if (isAllowedAccess) {
            return;
          }
          chrome.tabs.update(details.tabId, {
            url: getViewerURL(details.url),
          });
        });
      }
    },
    {
      url: [
        { urlPrefix: "file://", pathSuffix: ".pdf" },
        { urlPrefix: "file://", pathSuffix: ".PDF" },
      ],
    }
  );
}

// Handle messages from debug page
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'reregisterRules') {
    console.log('PDF Viewer: Re-registration requested');
    registerPdfRedirectRule()
      .then(() => {
        sendResponse({ success: true, message: 'Rules re-registered successfully' });
      })
      .catch(error => {
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }
});

console.log('PDF Viewer: Background service worker initialized');
