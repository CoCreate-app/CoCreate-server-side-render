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

        // Does not support instanceof HTMLCollection
        async function render(html, lastKey) {
            const dom = parse(html);
            for (let el of dom.querySelectorAll(
                "[array][key][object]"
            )) {
                let meta = el.attributes;

                if (ignoreElement[el.tagName])
                    continue;

                if (el.closest('.template, [template], template, [render]'))
                    continue;

                if (el.hasAttribute('render-selector') || el.hasAttribute('render-closest') || el.hasAttribute('render-parent') || el.hasAttribute('render-next') || el.hasAttribute('render-previous'))
                    continue;

                if (el.hasAttribute('component') || el.hasAttribute('plugin'))
                    continue;

                if (el.hasAttribute('actions'))
                    continue;
                let _id = meta["object"],
                    array = meta['array'],
                    key = meta['key'];
                let crudKey = _id + array + key;
                if (!_id || !key || !array) continue;
                if (!checkValue(_id) || !checkValue(key) || !checkValue(array)) continue;
                if (dep.includes(crudKey))
                    throw new Error(
                        `infinite loop: ${lastKey} ${array} ${key} ${_id} has been already rendered`
                    );
                else
                    dep.push(crudKey)

                let cacheKey = _id + array;
                let data;
                if (dbCache.has(cacheKey))
                    data = dbCache.get(cacheKey)
                else {
                    data = await self.crud.send({
                        method: 'object.read',
                        array,
                        object: {
                            _id
                        },
                        organization_id
                    });
                    if (data && data.object && data.object[0])
                        data = data.object[0]

                    dbCache.set(cacheKey, data)
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
