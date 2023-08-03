const { parse } = require("node-html-parser");
const { checkValue } = require("@cocreate/utils");

class CoCreateServerSideRender {
    constructor(crud) {
        this.crud = crud;
    }

    async HTML(html, organization_id) {
        const self = this
        let ignoreElement = { INPUT: true, TEXTAREA: true, SELECT: true, LINK: true, IFRAME: true, "COCREATE-SELECT": true }

        let dep = [];
        let dbCache = new Map();

        async function render(html, lastKey) {
            const dom = parse(html);
            for (let el of dom.querySelectorAll(
                "[array][name][object]"
            )) {
                let meta = el.attributes;

                if (ignoreElement[el.tagName])
                    continue;

                if (el.closest('.template, [template], template, [render]'))
                    continue;

                if (el.hasAttribute('render-selector') || el.hasAttribute('render-closest') || el.hasAttribute('render-parent') || el.hasAttribute('render-next') || el.hasAttribute('render-next'))
                    continue;

                if (el.hasAttribute('component') || el.hasAttribute('plugin'))
                    continue;

                if (el.hasAttribute('actions'))
                    continue;
                let _id = meta["object"],
                    array = meta['array'],
                    name = meta['name'];
                let key = _id + array + name;
                if (!_id || !name || !array) continue;
                if (!checkValue(_id) || !checkValue(name) || !checkValue(array)) continue;
                if (dep.includes(key))
                    throw new Error(
                        `infinite loop: ${lastKey} ${array} ${name} ${_id} has been already rendered`
                    );
                else
                    dep.push(key)

                let cacheKey = _id + array;
                let record;
                if (dbCache.has(cacheKey))
                    record = dbCache.get(cacheKey)
                else {
                    record = await self.crud.send({
                        method: 'read.object',
                        array,
                        object: {
                            _id
                        },
                        organization_id
                    });
                    if (record && record.object && record.object[0])
                        record = record.object[0]

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
        let result = await render(html, 'root');
        dep = [];
        dbCache.clear();
        return result.toString();
    }
}

module.exports = CoCreateServerSideRender;
