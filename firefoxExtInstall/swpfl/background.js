// background.js

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "makeFetchRequest") {
    const { url, init } = message;

    // Reconstruct Headers object if sent as a plain object
    if (init && init.headers && typeof init.headers === 'object' && !(init.headers instanceof Headers)) {
        init.headers = new Headers(init.headers);
    }

    // Use fetch in the background script
    return fetch(url, init)
      .then(async response => { // Mark as async to use await for body reading
        // Clone the response to read body streams multiple times if needed (though we only read once here)
        const clonedResponse = response.clone();

        // Determine how to read the body based on content-type or if it's likely JSON
        const contentType = response.headers.get('content-type') || '';
        let bodyData;
        let isJson = false;

        if (contentType.includes('application/json') || response.status === 204) { // Handle 204 No Content as no JSON
          try {
            bodyData = await clonedResponse.json();
            isJson = true;
          } catch (e) {
            // If it claims JSON but fails to parse (e.g., empty response, malformed),
            // treat it as text or null.
            bodyData = await clonedResponse.text();
            isJson = false;
          }
        } else {
          bodyData = await clonedResponse.text();
        }

        // Prepare headers for sending back
        const headers = {};
        for (let pair of response.headers.entries()) {
          headers[pair[0]] = pair[1];
        }

        // Send back a simplified representation of the response
        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          headers: headers,
          jsonData: isJson ? bodyData : undefined, // Send JSON data if applicable
          textData: !isJson ? bodyData : undefined, // Send text data otherwise
          url: response.url
        };
      })
      .catch(error => {
        console.error("Background fetch error:", error);
        // Send back an error state that content script can interpret
        return {
          ok: false,
          status: 0, // Indicate a network or unknown error
          statusText: error.message || "Background fetch failed",
          headers: {},
          jsonData: null,
          textData: null,
          error: { message: error.message, stack: error.stack } // Provide error details
        };
      });
  }
});
