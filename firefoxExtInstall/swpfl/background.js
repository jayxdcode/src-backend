browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "makeFetchRequest") {
    const { url, init } = message;
    
    return new Promise((resolve) => {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open(init?.method || 'GET', url, true);
        
        if (init?.headers && typeof init.headers === 'object') {
          for (const key in init.headers) {
            if (Object.hasOwnProperty.call(init.headers, key)) {
              xhr.setRequestHeader(key, init.headers[key]);
            }
          }
        }
        
        xhr.onreadystatechange = function() {
          if (xhr.readyState === XMLHttpRequest.DONE) {
            const rawHeaders = xhr.getAllResponseHeaders().trim();
            
            // Convert raw header string into an object
            const headersObj = {};
            rawHeaders.split('\n').forEach(line => {
              const parts = line.split(': ');
              if (parts.length === 2) {
                headersObj[parts[0].toLowerCase()] = parts[1];
              }
            });
            
            resolve({
              ok: xhr.status >= 200 && xhr.status < 300,
              status: xhr.status,
              statusText: xhr.statusText,
              textData: xhr.responseText, // <- rename here
              headers: headersObj, // <- parse to object
              url: xhr.responseURL || url
            });
          }
        };
        
        xhr.onerror = function() {
          resolve({
            ok: false,
            status: xhr.status || 0,
            statusText: xhr.statusText || "XHR error",
            textData: null,
            headers: {},
            url: url,
            error: { message: "Network error", stack: "" }
          });
        };
        
        xhr.send(init?.body || null);
      } catch (error) {
        console.error("Background XHR error:", error);
        resolve({
          ok: false,
          status: 0,
          statusText: error.message || "XHR failed",
          textData: null,
          headers: {},
          url: url,
          error: { message: error.message, stack: error.stack }
        });
      }
    });
  }
});