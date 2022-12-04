const { parse } = require("node-html-parser");

class CoCreateServerSideRender {
	constructor(crud) {
		this.crud = crud;
		this.renderedIgnoreEl = { INPUT: true, TEXTAREA: true, SELECT: true, LINK: true, IFRAME: true, "COCREATE-SELECT": true }
	}

    async html(html) {

        let dep = [];
        let dbCache = new Map();
    
        async function render(html, lastKey) {
            const dom = parse(html);
            for (let el of dom.querySelectorAll(
                    "[collection][name][document_id]"
                )) {
                let meta = el.attributes;
    
                if (renderedIgnoreEl[el.tagName])
                    continue;
                    
                if (el.tagName == "DIV" && !el.classList.contains('domEditor'))
                    continue;
                    
                if (el.classList.contains('domEditor') && el.closest('.template'))
                    continue;
                
                if (el.hasAttribute('actions'))
                    continue;
    
                let _id = meta["document_id"],
                    collection = meta['collection'],
                    name = meta['name'];
                let key = _id + collection + name;
                if (!_id || !name || !collection) continue;
                if (dep.includes(key))
                    throw new Error(
                        `infinite loop: ${lastKey} ${_id} ${collection} ${name}  has been already rendered`
                    );
                else
                    dep.push(key)
    
                let cacheKey = _id + collection;
                let record;
                if (dbCache.has(cacheKey))
                    record = dbCache.get(cacheKey)
                else {
                    record = await this.crud.readDocument({
                        collection,
                        document: {
                            _id
                        }
                    });
                    record = record.document[0]
                    dbCache.set(cacheKey, record)
                }
    
                if (!record || !record[name]) {
                    dep.pop();
                    continue;
                }
                let chunk = record[name];
                if (!chunk) {
    
                    dep.pop();
                    continue;
                }
                let dom = await render(chunk);
    
                el.setAttribute('rendered', '')
                el.innerHTML = "";
                el.appendChild(dom);
    
    
                dep.pop();
            }
    
            return dom;
        }
        let result = (await render(html, 'root')).toString();
        return result;
    }
}

module.exports = CoCreateServerSideRender;
