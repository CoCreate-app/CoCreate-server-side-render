const { parse } = require("node-html-parser");
const { checkValue, ObjectId } = require("@cocreate/utils");

// Using a Set for O(1) lookups is slightly cleaner and faster than an object map
const IGNORE_ELEMENTS = new Set([
    "INPUT", "TEXTAREA", "SELECT", "LINK", "IFRAME", "COCREATE-SELECT"
]);

// Prevent these tags from triggering the generic [src] chunk-fetching logic
const SKIP_SRC_ELEMENTS = new Set([
    "SCRIPT", "IMG", "IFRAME", "AUDIO", "VIDEO", "SOURCE", "TRACK", "INPUT", "EMBED", "FRAME"
]);

// OPTIMIZATION: Helper to check if a node is still attached to the active document tree
// This prevents processing orphaned child elements whose parents were overwritten/replaced
function isNodeConnected(node, root) {
    let current = node;
    while (current) {
        if (current === root) return true;
        current = current.parentNode;
    }
    return false;
}

class CoCreateServerSideRender {
    constructor(crud) {
        this.crud = crud;
    }

    async HTML(file, organization, urlObject, langRegion, lang, theme) {
        const self = this;
        let dep = [];
        let dbCache = new Map();
        
        const organization_id = file.organization_id;
        const host = urlObject.hostname;

        // FIX: Ensure file.path has a fallback to prevent "Cannot read properties of undefined (reading 'endsWith')"
        const filePath = file.path || file.pathname || "/";

        async function render(dom, lastKey) {
            // Combined query to traverse elements only once
            const elements = dom.querySelectorAll(
                "[array][key][object], [src]:not(script, img, iframe, audio, video, source, track, input, embed, frame)"
            );

            for (let el of elements) {
                // OPTIMIZATION: Skip processing if this element was detached by a previous parent render
                if (!isNodeConnected(el, dom)) continue;

                let isData = el.hasAttribute("array") && el.hasAttribute("key") && el.hasAttribute("object");
                let isSrc = el.hasAttribute("src") && !SKIP_SRC_ELEMENTS.has(el.tagName.toUpperCase());

                // 1. Process Data Source
                if (isData) {
                    let shouldProcessData = true;

                    // Exclude specific ignore tags, templates, actions, and components from rendering database-driven values
                    if (IGNORE_ELEMENTS.has(el.tagName.toUpperCase())) {
                        shouldProcessData = false;
                    } else if (el.closest(".template, [template], template, [render]")) {
                        shouldProcessData = false;
                    } else if (el.hasAttribute("render-query") || el.hasAttribute("component") || el.hasAttribute("plugin") || el.hasAttribute("actions")) {
                        shouldProcessData = false;
                    }

                    if (shouldProcessData) {
                        let _id = el.getAttribute("object");
                        let array = el.getAttribute("array");
                        let key = el.getAttribute("key");

                        if (_id && key && array && checkValue(_id) && checkValue(key) && checkValue(array)) {
                            let crudKey = `${_id}${array}${key}`;
                            
                            if (dep.includes(crudKey)) {
                                throw new Error(`Infinite loop detected: ${lastKey} ${array} ${key} ${_id} has already been rendered.`);
                            }
                            dep.push(crudKey);

                            let cacheKey = `${_id}${array}`;
                            let data;
                            
                            if (dbCache.has(cacheKey)) {
                                data = dbCache.get(cacheKey);
                            } else {
                                data = await self.crud.send({
                                    method: "object.read",
                                    host,
                                    array,
                                    object: { _id },
                                    organization_id
                                });
                                if (data?.object?.[0]) data = data.object[0];
                                dbCache.set(cacheKey, data);
                            }

                            if (data && data[key] !== undefined && data[key] !== null) {
                                let chunkVal = data[key];
                                
                                // Normalize non-string values safely to strings before parsing (e.g. booleans, numbers)
                                let chunkStr = typeof chunkVal === 'string' ? chunkVal : String(chunkVal);
                                
                                let chunkDom = parse(chunkStr);

                                // Recursively resolve all nested requirements in the chunk BEFORE inserting it
                                chunkDom = await render(chunkDom, crudKey);
                                el.setAttribute("rendered", "");
                                el.innerHTML = "";
                                
                                // Use node-html-parser compatible appendChild loop instead of el.append()
                                if (chunkDom.childNodes) {
                                    for (const child of chunkDom.childNodes) {
                                        el.appendChild(child);
                                    }
                                } else {
                                    el.appendChild(chunkDom);
                                }
                            }
                            dep.pop();
                        }
                    }
                }

                // OPTIMIZATION: Verify the element is still connected, as the isData routine above could have modified/cleared its parent
                if (!isNodeConnected(el, dom)) continue;

                // 2. Process File Source (Runs independently, allowing elements to utilize both features concurrently)
                if (isSrc) {
                    let src = el.getAttribute("src");
                    if (src) {
                        // FIX: Use safe filePath variable
                        let pathname = filePath;
                        if (!pathname.endsWith("/")) pathname += "/";
                        
                        pathname = new URL(src, `http://localhost${pathname}`).pathname;
                        if (pathname.endsWith("/")) pathname += "index.html";

                        // CIRCULAR DEPENDENCY CHECK: Track active src resolution paths in loop prevention list
                        let srcKey = `file:${pathname}`;
                        if (dep.includes(srcKey)) {
                            throw new Error(`Infinite loop detected: File ${pathname} is in a circular import chain.`);
                        }
                        dep.push(srcKey);

                        let data = await self.crud.send({
                            method: "object.read",
                            host,
                            array: "files",
                            object: "",
                            $filter: { query: { pathname } },
                            organization_id
                        });

                        let fetchedFile = data?.object?.[0] || null;

                        // Intelligent Status Code Handling
                        let statusCode = fetchedFile?.status;
                        if (!statusCode) {
                            if (!fetchedFile || !fetchedFile.src) statusCode = 404;
                            else if (fetchedFile.public === false || String(fetchedFile.public) === "false") statusCode = 403;
                            else statusCode = 200;
                        }

                        if (statusCode >= 400) {
                            el.setAttribute("error", statusCode.toString());
                        } else {
                            let chunkVal = fetchedFile.src;

                            // Decode base64 SVG if necessary
                            if (typeof chunkVal === "string" && chunkVal.startsWith("data:image/svg+xml;base64,")) {
                                chunkVal = Buffer.from(chunkVal.split(",")[1], "base64").toString("utf-8");
                            }

                            // Normalize non-string values safely to strings before parsing (failsafe)
                            let chunkStr = typeof chunkVal === 'string' ? chunkVal : String(chunkVal);

                            let chunkDom = parse(chunkStr);
                            // Recursively resolve all nested requirements in the chunk BEFORE inserting it
                            chunkDom = await render(chunkDom, "src-chunk");

                            const valueType = el.getAttribute("value-type");
                            if (valueType === "outerHTML") {
                                if (chunkDom.childNodes?.length) {
                                    el.replaceWith(...chunkDom.childNodes);
                                } else {
                                    el.remove();
                                }
                            } else {
                                el.setAttribute("rendered", "");
                                el.innerHTML = "";
                                
                                // Use node-html-parser compatible appendChild loop instead of el.append()
                                for (const child of chunkDom.childNodes) {
                                    el.appendChild(child);
                                }
                            }
                        }
                        dep.pop(); // Complete tracking cycle for this source resolution
                    }
                }
            }

            return dom;
        }

        // Apply parsing directly on root file source without modifying any paths
        let rootSrc = file.src;

        // Initialize recursion tracker with the primary file pathname to catch immediate self-reference imports
        // FIX: Use safe filePath variable
        const rootNormalizedPath = filePath.endsWith("/") ? `${filePath}index.html` : filePath;
        dep.push(`file:${rootNormalizedPath}`);

        let dom = parse(rootSrc);
        dom = await render(dom, "root");
        
        if (langRegion || lang) {
            dom = await this.translate(dom, file, langRegion, lang);
        }

        if (theme) {
            const htmlEl = dom.querySelector("html");
            try {
                if (htmlEl?.setAttribute) htmlEl.setAttribute("data-bs-theme", theme);

                const head = dom.querySelector("head");
                if (head) {
                    let meta = head.querySelector('meta[name="color-scheme"]');
                    if (meta?.setAttribute) {
                        meta.setAttribute("content", theme);
                    } else {
                        const metaNode = parse(`<meta name="color-scheme" content="${theme}">`);
                        head.appendChild(metaNode);
                    }
                }
            } catch (e) {
                // fail-safe
            }
        }

        if (organization?.languages?.length > 0) {
            let langLinkTags = this.createLanguageLinkTags(file, organization, urlObject);
            const head = dom.querySelector("head");
            if (head && langLinkTags) {
                const linksFragment = parse(langLinkTags);
                // Use standard loop and appendChild for appending alternate language link tags to the head
                for (const link of linksFragment.querySelectorAll("link")) {
                    head.appendChild(link);
                }
            }
        }

        dep = [];
        dbCache.clear();
        
        let finalHtml = dom.toString();

        // Apply ObjectId generation globally across the fully rendered document
        finalHtml = finalHtml.replaceAll("ObjectId()", () => ObjectId().toString());

        return finalHtml;
    }

    createLanguageLinkTags(file, organization, urlObject) {
        let generatedLinksString = `<link rel="alternate" hreflang="x-default" href="https://${urlObject.hostname}${file.pathname}">\n`;
        for (const language of organization.languages) {
            const hrefUrl = `https://${urlObject.hostname}/${language}${file.pathname}`;
            generatedLinksString += `<link rel="alternate" hreflang="${language}" href="${hrefUrl}">\n`;
        }
        return generatedLinksString;
    }

    async translate(dom, file, langRegion, lang) {
        if (!file.translations || (!langRegion && !lang)) return dom;

        for (let translation of file.translations) {
            let elements = dom.querySelectorAll(translation.selector) || [];
            for (let el of elements) {
                if (!el) continue;
                
                if (translation.innerHTML) {
                    let content = translation.innerHTML[langRegion] || translation.innerHTML[lang];
                    if (content) el.innerHTML = content;
                }
                
                if (translation.attributes) {
                    for (let [key, languageObj] of Object.entries(translation.attributes)) {
                        let value = languageObj[langRegion] || languageObj[lang];
                        if (value) el.setAttribute(key, value);
                    }
                }
            }
        }
        return dom;
    }
}

module.exports = CoCreateServerSideRender;