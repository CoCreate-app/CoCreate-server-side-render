const { parse } = require("node-html-parser");
const { checkValue, getRelativePath, ObjectId } = require("@cocreate/utils");
const path = require("path");

class CoCreateServerSideRender {
	constructor(crud) {
		this.crud = crud;
	}

	async HTML(file, organization, urlObject, langRegion, lang, theme) {
		const self = this;
		let ignoreElement = {
			INPUT: true,
			TEXTAREA: true,
			SELECT: true,
			LINK: true,
			IFRAME: true,
			"COCREATE-SELECT": true
		};

		let dep = [];
		let dbCache = new Map();
		let organization_id = file.organization_id;
		const host = urlObject.hostname;

		async function render(dom, lastKey) {
			// Handle elements with [array][key][object]
			for (let el of dom.querySelectorAll("[array][key][object]")) {
				let meta = el.attributes;

				if (ignoreElement[el.tagName]) continue;

				if (el.closest(".template, [template], template, [render]"))
					continue;

				if (el.hasAttribute("render-query")) continue;

				if (el.hasAttribute("component") || el.hasAttribute("plugin"))
					continue;

				if (el.hasAttribute("actions")) continue;

				let _id = meta["object"],
					array = meta["array"],
					key = meta["key"];
				let crudKey = _id + array + key;

				if (!_id || !key || !array) continue;
				if (!checkValue(_id) || !checkValue(key) || !checkValue(array))
					continue;
				if (dep.includes(crudKey))
					throw new Error(
						`infinite loop: ${lastKey} ${array} ${key} ${_id} has been already rendered`
					);
				else dep.push(crudKey);

				let cacheKey = _id + array;
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
					if (data && data.object && data.object[0])
						data = data.object[0];

					dbCache.set(cacheKey, data);
				}

				if (!data || !data[key]) {
					dep.pop();
					continue;
				}

				let chunk = data[key];
				if (!chunk) {
					dep.pop();
					continue;
				}

				chunk = await render(chunk);

				el.setAttribute("rendered", "");
				el.innerHTML = "";
				el.appendChild(chunk);

				dep.pop();
			}

			// ToDo: Fetch and render src, update relativePath. must have similar functionality to @cocreate/elements/fetch-src
			// Handle elements with [src]
			for (let el of dom.querySelectorAll(
				"[src]:not(script, img, iframe, audio, video, source, track, input, embed, frame)"
			)) {
				let src = el.getAttribute("src");
				if (!src) continue;

				let path =
					el.getAttribute("path") || getRelativePath(file.path);

				if (path) {
					src = src.replaceAll(/\$relativePath\/?/g, path);
				}

				let pathname = file.path
				if (!pathname.endsWith("/")) {
					pathname += "/";
				}
				// Construct actual pathname using src and the original URL
				pathname = new URL(src, `http://localhost${pathname}`)
					.pathname;

				if (pathname.endsWith("/")) {
					pathname += "index.html";
				}
				let $filter = {
					query: {
						pathname: pathname
					}
				}; // Use filter to structure query

				let data = await self.crud.send({
					method: "object.read",
					host,
					array: "files",
					object: "",
					$filter,
					organization_id
				});

				if (
					data &&
					data.object &&
					data.object[0] &&
					data.object[0].src
				) {
					let chunk = data.object[0].src;

					if (typeof chunk === "string" && chunk.startsWith("data:image/svg+xml;base64,")) {
						chunk = Buffer.from(chunk.split(",")[1], "base64").toString("utf-8");
					}

					// Replace $relativePath in the fetched chunk
					let path =
						el.getAttribute("path") || getRelativePath(file.path);
					if (path) {
						chunk = chunk.replaceAll(/\$relativePath\/?/g, path);
					}

					// Replace ObjectId() with a new ObjectId
					chunk = chunk.replaceAll("ObjectId()", () => {
						// Generate a NEW ObjectId inside the function
						return ObjectId().toString(); // Return its string representation
					});

					// Parse chunk into DOM before recursive rendering
					let chunkDom = parse(chunk);
					chunkDom = await render(chunkDom);

					// If element requests outerHTML insertion, replace the element
					// with the fetched chunk's content. Otherwise append children.
					const valueType = el.getAttribute && el.getAttribute("value-type");
					if (valueType === "outerHTML") {
						// Replace the element with the parsed chunk's child nodes
						// spread child nodes so we don't create an extra wrapper
						if (chunkDom.childNodes && chunkDom.childNodes.length) {
							el.replaceWith(...chunkDom.childNodes);
						} else {
							// If no child nodes, just remove the element
							el.remove();
						}
					} else {
						el.setAttribute("rendered", "");
						el.innerHTML = "";
						for (const child of chunkDom.childNodes) {
							el.appendChild(child);
						}
					}
				}
			}

			return dom;
		}

		let dom = parse(file.src);
		dom = await render(dom, "root");
		if (langRegion || lang) {
			dom = await this.translate(dom, file, langRegion, lang);
		}

		// Inject preferred theme into the DOM so client gets server-rendered theme
		if (theme) {
			const htmlEl = dom.querySelector("html");
			try {
				if (htmlEl && htmlEl.setAttribute) htmlEl.setAttribute("data-bs-theme", theme);

				const head = dom.querySelector("head");
				if (head) {
					// add or update color-scheme meta tag
					let meta = head.querySelector('meta[name="color-scheme"]');
					if (meta && meta.setAttribute) {
						meta.setAttribute("content", theme);
					} else {
						const metaNode = parse(`<meta name="color-scheme" content="${theme}">`);
						head.appendChild(metaNode);
					}
				}
			} catch (e) {
				// fail-safe: don't abort rendering if theme injection fails
			}
		}

		if (organization.languages && organization.languages.length > 0) {
			let langLinkTags = this.createLanguageLinkTags(
				file,
				organization,
				urlObject
			);
			const head = dom.querySelector("head");
			if (head && langLinkTags) {
				const linksFragment = parse(langLinkTags);
				for (const link of linksFragment.querySelectorAll("link")) {
					head.appendChild(link);
				}
				// Remove the fragment node from the DOM if it exists
				if (linksFragment.parentNode) {
					linksFragment.remove();
				}
			}
		}

		dep = [];
		dbCache.clear();
		return dom.toString();
	}

	createLanguageLinkTags(file, organization, urlObject) {
		let generatedLinksString = `<link rel="alternate" hreflang="x-default" href="https://${urlObject.hostname}${file.pathname}">\n`;

		for (const language of organization.languages) {
			let langPath = `/${language}${file.pathname}`;
			const hrefUrl = `https://${urlObject.hostname}${langPath}`;
			generatedLinksString += `<link rel="alternate" hreflang="${language}" href="${hrefUrl}">\n`;
		}
		return generatedLinksString;
	}

	async translate(dom, file, langRegion, lang) {
		if (file.translations && (langRegion || lang)) {
			for (let translation of file.translations) {
				let elements = dom.querySelectorAll(translation.selector) || [];
				for (let el of elements) {
					if (!el) continue;
					if (translation.innerHTML) {
						let content =
							translation.innerHTML[langRegion] ||
							translation.innerHTML[lang];
						if (content) {
							el.innerHTML = content;
						}
					}
					if (translation.attributes) {
						for (let [key, languageObj] of Object.entries(
							translation.attributes
						)) {
							let value =
								languageObj[langRegion] || languageObj[lang];
							if (value) {
								el.setAttribute(key, value);
							}
						}
					}
				}
			}
		}
		return dom;
	}
}

module.exports = CoCreateServerSideRender;
