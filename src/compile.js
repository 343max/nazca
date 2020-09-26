const fs = require('fs');
const path_ = require('path');
const parse = require('node-html-parser').parse;
const tools = require('./tools');

const htmlTags = require('./htmlTags');

let classes_ = {};
let hierarchy_ = {children: []};
let css_ = '';
let html_ = '';
let js_ = '';
let elements_ = [];

/**
 * Nazca compiler. Compiles *.nazca files, described by .nazca in the root directory to the JS/HTML/CSS
 *
 * @author Q'inti qinti.nazca@gmail.com
 *
 * Compiles nazca files into html/css and js files
 *
 * Algorithm:
 * 1. Go through the file, replacing *include with an actual file content
 * 2. Create a map of classes
 * 3. Create a hierarchy of the page
 * 4. Starting generating the html/css/js
 * 5. Go through the classes - define css classes with properties
 * 6. Go through the hierarchy - define html, generate ids for each element that can be referenced
 * 7. Go though the classes - generate functions (JS classes)
 * 8. Search for *json, add <script> to the hierarchy
 * 9. Create global objects from hierarchy
 * 10. Write html, css, js file for each page
 */

let configLoadPromise = new Promise((resolve, reject) => {
    fs.readdir('.', (err, files) => {
        if (err) {
            return reject(err);
        }

        if (!files.includes('.nazca')) {
            return reject(new Error(`Folder does not contain .nazca config file. Please add .nazca file to the project with compile instructions. \nRun 'nazca init' to create default .nazca configuration.`));
        }

        fs.readFile('.nazca', (err, content) => {
            if (err) {
                return reject(err);
            }

            let config;
            let index = 0;
            content = content.toString();
            [
                {openSymbol: '/*', closeSymbol: '*/'},
                {openSymbol: '//', closeSymbol: '\n', replacement: '\n'}
            ].forEach(({openSymbol, closeSymbol, replacement}) => {
                index = 0;
                while (index >= 0) {
                    index = content.indexOf(openSymbol);

                    if (index >= 0) {
                        let close = content.indexOf(closeSymbol, index + openSymbol.length);
                        content = `${content.slice(0, index)}${replacement || ''}${content.slice(close + closeSymbol.length)}`;
                    }
                }
            });

            try {
                config = JSON.parse(content.toString().replace(/\/\/.*\n|\/\*(.|\n)*\*\//g, ''));
            } catch (e) {
                return reject(e);
            }

            resolve(config);
        });
    });
});

configLoadPromise.then(async (config) => {
    if (!config.out) {
        config.out = 'www';
    }

    if (config.sources || !config.sources.length) {
        for (let name in config.sources) {
            let file = `./${config.sources[name]}`;
            await compile(file, name, config.out, config.beautify);
        }
    } else {
        /* eslint-disable no-throw-literal */
        throw {message: '.nazca config file should have sources array'};
    }

    if (!config.beautify) {
        config.beautify = 0;
    }
}).catch((err) => {
    console.error(err.message);
});

function read(file) {
    return new Promise((resolve, reject) => {
        fs.readFile(file, (err, content) => {
            if (err) {
                return reject(err);
            }
            resolve(content.toString());
        });
    });
}

function compile(file, name, out, beautify) {
    classes_ = {};
    let content_;

    classes_ = {};
    hierarchy_ = {children: []};
    css_ = '';
    html_ = '';
    js_ = '';
    elements_ = [];

    tools.resetID();

    // 1. Find all includes and merge the file into one
    return recursivelyInclude(file).then((content) => {
        tools.buildStrings(content);
        content_ = content;
        // 2. Create a map of classes
        classes_ = tools.getClassMap(content);
    }).then(() => {
        // 3. Create a hierarchy of the page

        // removing all the classes from the file
        let classless = '';
        let closingBracket = 0;
        let classIndex = content_.indexOfCode('class ');
        while (classIndex >= 0) {
            classless += content_.slice(closingBracket, classIndex);
            let openBracket = content_.indexOfCode('{', classIndex);
            closingBracket = tools.findClosingBracket(content_, openBracket);
            closingBracket += 2;
            classIndex = content_.indexOfCode('class ', classIndex + 1);
        }
        classless += content_.slice(closingBracket);

        tools.buildStrings(classless);

        hierarchy_ = {children: tools.getChildren(classless)};
    }).then(() => {
        // 4. Starting generating the html/css/js

        // Handle the *font-face directive
        let index = content_.indexOfCode('*font-face:');
        while (index >= 0) {
            let openingBracket = content_.indexOfCode('{', index);
            let closingBracket = tools.findClosingBracket(content_, openingBracket);

            css_ += `@font-face ${content_.slice(openingBracket, closingBracket + 1)}\n`;
            index = content_.indexOfCode('*font-face:', closingBracket);
        }

        // 5. Go through the classes - define css classes with properties

        for (let className in classes_) {
            if (Object.keys(classes_[className].style).length) {
                css_ += `.${className} {\n`;

                let parents = classes_[className].parents.reverse();
                parents.forEach((parent) => {
                    if (classes_[parent] && Object.keys(classes_[parent].style).length) {
                        for (let property in classes_[parent].style) {
                            let value = classes_[parent].style[property];
                            if (value.charAt(0) === value.charAt(value.length - 1) && value.charAt(0) === `'`) {
                                value = value.slice(1, value.length - 1);
                            }
                            css_ += `    ${property}: ${value};\n`
                        }
                    }
                });

                for (let property in classes_[className].style) {
                    let value = classes_[className].style[property];
                    if (value != `''`) {
                        if (value.charAt(0) === value.charAt(value.length - 1) && value.charAt(0) === `'`) {
                            value = value.slice(1, value.length - 1);
                        }
                        css_ += `    ${property}: ${value};\n`
                    }
                }

                css_ += `}\n\n`;
            }

            if (Object.keys(classes_[className].states).length) {
                for (let state in classes_[className].states) {
                    css_ += `.${className}:${state} ${classes_[className].states[state]}\n`;
                }
            }
        }
    }).then(() => {
        // 6. Go through the hierarchy - define html, generate ids for each element that can be referenced

        hierarchy_.children.forEach((child) => {
            html_ += getHTMLObject(child);
        });

        let root = parse(html_);
        let head = root.querySelector('head');
        if (!head) {
            let html = root.querySelector('html');
            if (!html) {
                throw {
                    message: 'Your hierarchy should have html as a parent node'
                };
            }
            html.appendChild('<head></head>');

            root = parse(root.innerHTML);
            head = root.querySelector('head');
        }

        let fileName = name.replace(/[\/\\]/g, '');

        head.appendChild(`<script src="/${out.js}/${fileName}.js" type="application/javascript"></script>`);
        head.appendChild(`<link rel="stylesheet" type="text/css" href="/${out.css}/${fileName}.css">`);

        html_ = root.innerHTML;
    }).then(() => {
        // 7. Go though the classes - generate functions (JS classes)

        for (let className in classes_) {
            let clss = classes_[className];
            let body = getClassCode(className, clss);
            js_ += body;
        }

        // 8. Search for *json, add <script> to the hierarchy
        let jsonFiles = tools.getListOfJSONFiles(content_);
        jsonFiles.forEach(({name, value}) => {
            js_ += `{
                let xhr = new XMLHttpRequest();
                xhr.open('GET', '${value}');
                let isResolved = false;
                let callbacks_ = [];
        
                xhr.onload = () => {
                    if (xhr.status == 404) {
                        return   console.error("Could not get '${value}'");
                    }
                    
                    isResolved = true;
                    try {
                        let data = JSON.parse(xhr.response);
                        Object.assign(window['${name}'], data);
                    } catch (e) {
                        return console.error("The json '${name}' at path '${value}' is not correct and can't be parsed.");
                    }
        
                    callbacks_.forEach((callback) => {
                        callback(window['${name}']);
                    });
                    callbacks_ = [];
                };
        
                xhr.setRequestHeader("Content-Type", "application/json;charset=UTF-8");
                xhr.send();
        
                window['${name}'] = {};
                window['${name}'].ready = (callback) => {
                    if (isResolved) {
                        callback();
                     } else {
                        callbacks_.push(callback);
                     }
                };
            }`;
        });
    }).then(() => {
        // 9. create global objects from hierarchy
        js_ += `document.addEventListener("DOMContentLoaded", () => {\n`;
        hierarchy_.children.forEach((child) => {
            js_ += getJSFromHierarchy(child) || '';
        });

        js_ += `});\n`;
    }).then(() => {
        // 10. Write html, css, js file for each page
        function writeCallback(err) {
            if (err) {
                console.error(err);
            }
        }

        let fileName = name.replace(/[\/\\]/g, '');
        let htmlName = `${name}.html`;
        let putInFolder = false;
        if (/[\/\\]/.test(name)) {
            htmlName = path_.join(name, 'index.html');
            putInFolder = true;
        }

        let foldersForCreation = [path_.join(out.path, out.js), path_.join(out.path, out.html), path_.join(out.path, out.css)];
        if (putInFolder) {
            foldersForCreation.push(path_.join(out.path, out.html, name));
        }
        foldersForCreation.forEach((path) => {
            makeDirHierarchy(path);
        });

        if (beautify === 1) {
            const beautifyJS = require('js-beautify');
            js_ = beautifyJS(js_, {indent_size: 4, space_in_empty_paren: true});
        } else if (beautify === -1) {
            const uglify = require("uglify-es");
            js_ = uglify.minify(js_, {
                mangle: {
                    toplevel: true,
                    eval: true
                },
                compress: {
                    sequences: true,
                    dead_code: true,
                    conditionals: true,
                    booleans: true,
                    unused: true,
                    if_return: true,
                    join_vars: true,
                    drop_console: true,
                    hoist_funs: true
                }
            }).code;
        } else if (!beautify) {
            beautify = 0;
        } else {
            throw {
                message: `'beautify' should be one of these values [-1;0;1]`
            }
        }

        fs.writeFile(path_.join(out.path, out.js, `${fileName}.js`), js_, writeCallback);
        fs.writeFile(path_.join(out.path, out.html, htmlName), html_, writeCallback);
        fs.writeFile(path_.join(out.path, out.css, `${fileName}.css`), css_, writeCallback);
    }).then(() => console.log(`\n${file} compiled ${beautify === 1 ? 'and beautified ' : (beautify === -1 ? 'and uglified ' : '')}successfully`)
    ).catch((e) => {
        let errorLocation;
        console.log(e);
        if (e.line.length && e.column.length) {
            errorLocation = `${e.line[0]}:${e.column[0]} - ${e.line[1]}:${e.column[1]}`;
        } else if (e.column.length) {
            errorLocation = `${e.line}:${e.column[0]} - ${e.line}:${e.column[1]}`;
        } else {
            errorLocation = `${e.line}:${e.column}`;
        }
        console.error(`\n[${errorLocation}] ${e.message}`);
    });
}

function getJSFromHierarchy(object, local = false, className, parentVariables) {
    let body = '';
    let variableIsSet = false;
    className = className || tools.nextID();

    function shouldGenerate(object) {
        // has name
        if (object.name) {
            return true;
        }
        // has methods
        if (Object.keys(object.methods.public).length) {
            return true;
        }
        // has public variables
        if (Object.keys(object.variables.public).length) {
            return true;
        }
        // has event handlers
        if (Object.keys(object.eventHandlers).length) {
            return true;
        }
        // has getters
        if (Object.keys(object.getters).length) {
            return true;
        }
        // has setters
        if (Object.keys(object.setters).length) {
            return true;
        }
        // has classes
        if (object.classes.length > 1 || (object.classes.length === 1 && !htmlTags[object.classes[0]])) {
            return true;
        }
        // has children that should be generated
        for (let i = 0, n = object.children.length; i < n; i++) {
            return shouldGenerate(object.children[i]);
        }

        return false;
    }

    if (shouldGenerate(object)) {
        object.parents = object.classes;
        body = getClassCode(className, object, local ? null : object.id);
        setVariable();
    }

    function setVariable() {
        if (variableIsSet) {
            return;
        }

        if (!object.name) {
            object.name = tools.nextID();
        }

        if (local) {
            body += `var ${object.name} = new ${className}();\n`;
            body += `__nazcaThis.__nazcaProtected.${object.name} = ${object.name};\n`;
        } else {
            body += `window.${object.name} = new ${className}();\n`;
        }
        variableIsSet = true;
        if (object.methods.public.constructor.body) {
            elements_.push(object.name);
        }
    }

    return body;
}

function getClassCode(className, clss, elementID = null) {
    let constructorParameters = [];
    let constructorBody;
    let body = '';
    let afterConstructor = '';

    // get constructor inputs
    if (clss.methods.public.constructor && clss.methods.public.constructor.parameters) {
        constructorParameters = clss.methods.public.constructor.parameters;
    }

    let classVariables = {
        css: Object.assign({}, clss.style),
        attributes: Object.assign({}, clss.attributes),
        getters: Object.assign({}, clss.getters),
        setters: Object.assign({}, clss.setters)
    };

    constructorBody = clss.methods.public.constructor.body;
    if (constructorBody) {
        constructorBody = getFunctionBody(replaceVariablesAndFunctions(constructorBody, classVariables, constructorParameters));
    }

    body += `function ${className}(${constructorParameters.join(', ')}) {\n`;

    let isElementDefined = false;
    // Inherit classes
    let classes = [];
    if (elementID) {
        body += `this.__nazcaElement = document.getElementById('${elementID}');\n`;
        isElementDefined = true;
    }

    for (let i = clss.parents.length - 1; i >= 0; i--) {
        let parent = clss.parents[i];
        if (parent && !htmlTags[parent]) {
            /* eslint-disable no-useless-escape */
            let regex = new RegExp(`\^\[['"\`]${parent}\[['"\`]]\s*}\(([a-z\d\s,]+)\);?`, 'gi');
            if (regex.test(body)) {
                let parametersString = regex.exec(body)[1];
                body = body.replace(regex, `${parent}.call(this${parametersString.length ? `, ${parametersString}` : ''});\n`);
            } else {
                regex = /\^\s*\(([a-zds,]+)\);?/gi;
                if (regex.test(body)) {
                    let parametersString = regex.exec(body)[1];
                    body = body.replace(regex, `${parent}.call(this${(parametersString.length ? `, ${parametersString}` : '')};\n`);
                } else {
                    body += `${parent}.call(this);\n`;
                }
            }

            classes.push(parent);
        } else if (parent && !elementID) {
            body += `if(!this.__nazcaElement){\n this.__nazcaElement = document.createElement('${parent}');\n}\n`;
            isElementDefined = true;
        }
    }

    // go through the parents in search of html tag
    if (!isElementDefined) {
        let parentsAreGraphical = clss.parents.map((parent) => isGraphicalClass(parent));
        isElementDefined = parentsAreGraphical.some((isGraphical) => isGraphical);
    }

    body += 'var __nazcaThis = this;\n';

    let defined = {};
    let childrenNames = {};
    for (let child in clss.children) {
        let name = clss.children[child].name;
        if (name) {
            childrenNames[name] = 1;
        }
    }
    for (let key in Object.assign({}, clss.variables.public, clss.variables.private, clss.variables.protected,
        clss.methods.public, clss.methods.private, clss.methods.protected, clss.style,
        childrenNames)) {
        defined[key] = defined[key] + 1 || 1;

        if (defined[key] > 1) {
            throw {
                message: `Class '${className}' has a duplicate variable '${key}'. public/protected/private methods and variables should have unique names`
            }
        }
    }

    body += `__nazcaThis.__nazcaProtected = __nazcaThis.__nazcaProtected || {};\n`;

    // Define public and protected parent variables as local variables
    if (classes.length) {
        ['variables', 'methods'].forEach((type) => {
            ['protected', 'public'].forEach((access) => {
                for (let parent in clss.parents) {
                    if (classes_[clss.parents[parent]]) {
                        for (let variable in classes_[clss.parents[parent]][type][access]) {
                            if (variable !== 'constructor') {
                                body += `var ${variable} = ${access === 'protected' ? '__nazcaThis.__nazcaProtected' : '__nazcaThis'}.${variable};\n`;
                            }
                        }
                    }
                }
            });
        });
    }

    // find all parents that should be overridden
    ['protected', 'public'].forEach((access) => {
        for (let method in clss.methods[access]) {
            let methodBody = clss.methods[access][method].body;
            let reParentMethod = /\^([a-z\n_$]+)\s*\(/gi;
            let exec = reParentMethod.exec(methodBody);
            if (exec) {
                exec.shift();

                exec.forEach((method) => {
                    body += `var __nazcaParent_${method} = ${method};\n`;
                    clss.methods[access][method].body = methodBody.replace(reParentMethod, `__nazcaParent_${method} (`);
                });
            }
        }
    });

    // Define variables
    ['variables', 'methods'].forEach((type) => {
        ['private', 'protected', 'public'].forEach((access) => {
            for (let variable in clss[type][access]) {
                let value = clss[type][access][variable];

                if (access === 'public' && type === 'variables' && variable === 'text') {
                    continue;
                }

                if (access === 'public' && type === 'methods' && variable === 'constructor') {
                    continue;
                }

                if (type === 'variables') {
                    let madeVariable = access === 'private' ? variable : tools.makeVariable(variable);
                    body += `var ${madeVariable}${value ? ` = ${addQuotes(value)}` : ''};\n`;
                    if (access === 'protected') {
                        afterConstructor += `__nazcaThis.__nazcaProtected.${variable} = ${madeVariable};\n`;
                    } else if (access === 'public') {
                        afterConstructor += `__nazcaThis['${variable}'] = '${madeVariable}';\n`;
                    }
                } else {
                    let method = variable;
                    body += `var ${method} = (${clss[type][access][method].parameters.join(', ')}) => `;
                    body += replaceVariablesAndFunctions(clss[type][access][method].body, classVariables, clss[type][access][method].parameters);
                    body += `\n`;

                    if (access === 'public') {
                        afterConstructor += `__nazcaThis.${method} = ${method};\n`;
                    } else if (access === 'protected') {
                        afterConstructor += `__nazcaThis.__nazcaProtected.${method} = ${method};\n`;
                    }
                }
            }
        });
    });

    // Define attributes, css
    if (isElementDefined) {
        for (let key in clss.attributes) {
            body += `Object.defineProperty(__nazcaThis, '$${key}', {\n`;
            body += `    get: () => __nazcaThis.__nazcaElement.getAttribute('${key}'),\n`;
            body += `    set: (value) => {__nazcaThis.__nazcaElement.setAttribute('${key}', value);},\n`;
            body += `    configurable: true\n`;
            body += `});\n`;
        }

        for (let key in clss.style) {
            body += `Object.defineProperty(__nazcaThis, '${key}', {\n`;
            body += `    get: () => __nazcaThis.__nazcaElement.style['${key}'],\n`;
            body += `    set: (value) => {__nazcaThis.__nazcaElement.style['${key}'] =  value;},\n`;
            body += `    configurable: true\n`;
            body += `});\n`;
        }

        body += `Object.defineProperty(__nazcaThis, 'text', {\n`;
        body += `    get: () => __nazcaThis.__nazcaElement.innerText,\n`;
        body += `    set: (value) => {__nazcaThis.__nazcaElement.innerText =  value;},\n`;
        body += `    configurable: true\n`;
        body += `});\n`;

        body += `Object.defineProperty(__nazcaThis, 'html', {\n`;
        body += `    get: () => __nazcaThis.__nazcaElement.innerHTML,\n`;
        body += `    set: (value) => {__nazcaThis.__nazcaElement.innerHTML =  value;},\n`;
        body += `    configurable: true\n`;
        body += `});\n`;

        body += `if (__nazcaThis.__nazcaElement.value !== undefined) {\n`;
        body += `    Object.defineProperty(__nazcaThis, 'value', {\n`;
        body += `        get: () => __nazcaThis.__nazcaElement.value,\n`;
        body += `        set: (value) => {__nazcaThis.__nazcaElement.value =  value;},\n`;
        body += `        configurable: true\n`;
        body += `    });\n`;
        body += `}\n`;

        classes.forEach((cls) => {
            body += `__nazcaThis.__nazcaElement.classList.add('${cls}');\n`;
        });

        if (classes_[className]) {
            body += `__nazcaThis.__nazcaElement.classList.add('${className}');\n`;
        }
    }

    // Define getters, setters
    let definedGetters = {};
    for (let key in clss.getters) {
        body += `Object.defineProperty(__nazcaThis, '${key}', {\n`;
        body += `    get: () => ${replaceVariablesAndFunctions(clss.getters[key].body, classVariables, clss.getters[key].parameters)},\n`;
        if (clss.setters) {
            body += `set: (${clss.setters[key].parameters.join(', ')}) => ${replaceVariablesAndFunctions(clss.setters[key].body, classVariables, clss.setters[key].parameters)},\n`;
        }
        body += `configurable: true\n`;
        body += `});\n`;
        definedGetters[key] = 1;
    }

    for (let key in clss.setters) {
        if (definedGetters[key] === 1) {
            continue;
        }

        body += `Object.defineProperty(__nazcaThis, '${key}', {\n`;
        body += `    set: (${clss.setters[key].parameters.join(', ')}) => ${replaceVariablesAndFunctions(clss.setters[key].body, classVariables, clss.setters[key].parameters)},\n`;
        body += `    configurable: true\n`;
        body += `});\n`;
    }

    // Define event listeners
    for (let event in clss.eventHandlers) {
        body += `__nazcaThis.__nazcaElement.addEventListener('${event}',function (${clss.eventHandlers[event].parameters.join(', ')}) ${replaceVariablesAndFunctions(clss.eventHandlers[event].body, classVariables, clss.eventHandlers[event].parameters)});\n`;
    }

    if (isElementDefined) {
        body += `var __nazcaChildren = {};\n`;
        body += `var __nazcaChildrenObjects = [];\n`;

        body += `__nazcaChildren.add = (object) => {\n`;
        body += `if (object.__nazcaElement) {\n`;
        body += `__nazcaThis.__nazcaElement.appendChild(object.__nazcaElement)\n`;
        body += `__nazcaChildrenObjects.push(object);\n`;
        body += `} else {\n`;
        body += `console.error("Can't append a child without element")}};\n`;

        body += `__nazcaChildren.remove = (object) => {\n`;
        body += `if (object.__nazcaElement) {\n`;
        body += `__nazcaThis.__nazcaElement.removeChild(object.__nazcaElement)\n`;
        body += `__nazcaChildrenObjects = __nazcaChildrenObjects.filter((obj) => obj !== object);\n`;
        body += `} else {\n`;
        body += `console.error("Can't remove a child without element")}};\n`;

        body += `__nazcaChildren.at = (index) => {\n`;
        body += `return __nazcaChildrenObjects[index];\n`;
        body += `};\n`;

        body += `Object.defineProperty(__nazcaChildren, 'length', {\n`;
        body += `get: () => __nazcaChildrenObjects.length,\n`;
        body += `});\n`;

        body += `Object.defineProperty(__nazcaThis, 'children', {\n`;
        body += `get: () => __nazcaChildren,\n`;
        body += `configurable: true\n`;
        body += `});\n`;

        // TODO Probably should add some insertion function as well and removal by index
    }

    clss.children.forEach((child) => {
        let id = tools.nextID();
        let js = getJSFromHierarchy(child, !elementID, id,
            Object.assign({}, clss.variables.protected, clss.variables.public, clss.attributes, clss.css));

        if (js) {
            body += js;
            body += `__nazcaThis.children.add(${elementID ? `window.${child.name}` : child.name});\n`;
        }
    });

    if (clss.variables.public.text) {
        body += `__nazcaThis.text = ${addQuotes(clss.variables.public.text)};\n`;
    }

    if (clss.variables.public.html) {
        body += `__nazcaThis.html = ${addQuotes(clss.variables.public.html)};\n`;
    }

    if (clss.variables.public.value) {
        body += `__nazcaThis.value = ${addQuotes(clss.variables.public.value)};\n`;
    }

    for (let attr in clss.attributes) {
        let value = clss.attributes[attr];
        body += `__nazcaThis['$${attr}'] = ${addQuotes(value)};\n`;
    }
    for (let css in clss.style) {
        let value = clss.style[css];
        body += `__nazcaThis['${css}'] = ${addQuotes(value)};\n`;
    }

    if (constructorBody) {
        body += `${constructorBody}\n`;
    }

    body += afterConstructor;
    afterConstructor = '';

    body += `}\n`;

    return body;
}

function getHTMLObject(object, indent = 0) {
    let element = 'div';
    let classes = [];
    let style = [];
    let attributes = [];
    if (object.classes) {
        object.classes.forEach((clss) => {
            if (htmlTags[clss]) {
                element = clss;
            } else {
                classes.push(clss);
            }

            if (classes_[clss]) {
                let parentElement = getParentElement(classes_[clss]);
                if (parentElement) {
                    element = parentElement;
                }
            }
        });
    }

    function getParentElement(parent) {
        let returnValue;
        parent.parents.forEach((clss) => {
            if (htmlTags[clss]) {
                returnValue = returnValue || clss;
            } else if (classes_[clss]) {
                returnValue = returnValue || getParentElement(classes_[clss]);
            }
        });

        return returnValue;
    }

    for (let key in object.style) {
        style.push(`${key}: ${object.style[key]};`);
    }

    for (let key in object.attributes) {
        attributes.push(`${key} = "${object.attributes[key]}"`);
    }

    let id = tools.nextID();
    object.id = id;

    let spaces = '';
    for (let i = 0; i < indent; i++) {
        spaces += ' ';
    }
    let nextSpaces = `    ${spaces}`;

    let html = `${spaces} <${element}`;
    html += `${classes.length ? ` class="${classes.join(' ')}"` : ''}`;
    html += `${style.length ? ` style="${style.join('')}"` : ''}`;
    html += `${attributes.length ? ` ${attributes.join(' ')}` : ''}`;
    html += ` id="${id}"`;
    html += '>\n';

    if (object.variables && object.variables.public && (object.variables.public.text || object.variables.public.html)) {
        html += `${nextSpaces}${object.variables.public.text || object.variables.public.html}\n`;
    } else {
        let classes = object.classes.slice().reverse();
        let isSet = false;
        classes.forEach((clss) => {
            if (!isSet && classes_[clss] && (classes_[clss].variables.public.text || classes_[clss].variables.public.html)) {
                html += `${nextSpaces}${classes_[clss].variables.public.text || classes_[clss].variables.public.html}\n`;
                isSet = true;
            }
        });
    }

    if (object.children) {
        object.children.forEach((child) => {
            html += getHTMLObject(child, indent + 4);
        });
    }
    html += `${spaces}</${element}>\n`;

    return html;
}

function recursivelyInclude(file) {
    let prePath = file.split(/\/|\\/);
    prePath.pop();
    prePath = prePath.join('/');
    return read(file).then((fileContent) => {
        let start = fileContent.indexOfCode('*include');
        let promises = [];
        let replacements = [];
        while (start >= 0) {
            let end = fileContent.indexOfCode(';', start);
            let includeString = fileContent.slice(start, end);

            /* eslint-disable no-unused-vars */
            let [name, path] = includeString.split(/:/);
            if (!path) {
                throw {message: '*include directive is invalid'};
            }

            path = path.replace(/'/g, '').trim();
            replacements.push({start, end});
            promises.push(recursivelyInclude(
                path_.join(prePath, path)
            ));

            start = fileContent.indexOfCode('*include', end);
        }

        return Promise.all(promises).then((contents) => {
            for (let i = contents.length - 1; i >= 0; i--) {
                fileContent = fileContent.slice(0, replacements[i].start) + contents[i] + fileContent.slice(replacements[i].end + 1);
            }

            return fileContent;
        });
    });
}

function getFunctionBody(bodyWithBrackets) {
    let openBracket = bodyWithBrackets.indexOfCode('{');
    let closeBracket = tools.findClosingBracket(bodyWithBrackets, openBracket + 1);
    return bodyWithBrackets.slice(openBracket + 1, closeBracket);
}

function replaceVariablesAndFunctions(body, classVariables, exceptParameters) {
    // separate function on lines
    let blockIndex = 0;
    let defined = [];
    let definedGlobally = [];

    let variables = Object.keys(Object.assign({}, classVariables.css, classVariables.attributes, classVariables.getters,
        classVariables.setters)).concat(['text', 'value', 'children', 'html']);

    for (let except in exceptParameters) {
        variables = variables.filter((value) => value !== exceptParameters[except]);
    }

    let innerBody = body.slice(1, body.length - 2);
    tools.buildStrings(innerBody, true);
    let lines = innerBody.splitLines();
    lines = lines.map((line) => {
        if (!line.trim()) {
            return;
        }
        let parts = line.split('{');
        parts = parts.map((part, index) => {
            if (!part.trim()) {
                return;
            }
            if (index > 1) {
                blockIndex++;
            }
            let subParts = part.split('}');
            subParts = subParts.map((part, subindex) => {
                if (!part.trim()) {
                    return;
                }

                if (index > 1 && subindex > 1) {
                    blockIndex--;
                }

                defined[blockIndex] = defined[blockIndex - 1] || defined[blockIndex] || {};
                if (part.indexOfCode('var') >= 0 || part.indexOfCode('const') >= 0 || part.indexOfCode('let') >= 0) {
                    let variables = /\blet\s+([a-z\d_$,\s]+)/i.exec(part) || [];
                    let constants = /\bconst\s+([a-z\d_$,\s]+)/i.exec(part) || [];
                    let gVariables = /\bvar\s+([a-z\d_$,\s]+)/i.exec(part) || [];

                    [variables, constants, gVariables] = [variables, constants, gVariables].map((variables) => {
                        if (variables.length) {
                            variables.shift();
                            variables = variables.map((variable) => variable.split(',').map((variable) => variable.trim()));
                            return [].concat.apply([], variables);
                        }

                        return variables;
                    });

                    for (let i = 0; i < variables.length; i++) {
                        let variable = variables[i];
                        defined[blockIndex][variable] = 1;
                    }

                    for (let i = 0; i < constants.concat(gVariables).length; i++) {
                        let variable = variables[i];
                        definedGlobally[variable] = 1;
                    }
                }

                variables.forEach((variable) => {
                    if (!(defined[blockIndex] && defined[blockIndex][variable]) && !definedGlobally[variable] && part.indexOf(variable) >= 0) {
                        part = replaceVariable(part, variable);
                    }
                });

                return part;
            });

            return subParts.join('}');
        });

        return parts.join('{');
    });

    return `{\n${lines.join('\n')}}\n`;
}

function replaceVariable(content, variableName) {
    if (!global.stringMap[content]) {
        tools.buildStrings(content, true);
    }

    [variableName, `['${variableName}']`, `[\`${variableName}\`]`, `["${variableName}"]`].forEach((variable) => {
        let index = content.indexOfCode(variable);
        while (index >= 0) {
            if (/[a-z._$\d]/i.test(content.charAt(index - 1))) {
                index = content.indexOfCode(variable, index + variable.length);
                continue;
            }

            let point = variable.indexOf('[') === 0 ? '' : '.';
            let replacement = `__nazcaThis${point}${variable}`;
            content = `${content.slice(0, index)}${replacement}${content.slice(index + variable.length)}`;
            index = content.indexOfCode(variable, index + replacement.length);
        }
    });

    return content;
}

function isGraphicalClass(clss) {
    if (!clss) {
        return false;
    }

    if (htmlTags[clss]) {
        return true;
    }

    if (!classes_[clss]) {
        throw {message: `The class ${clss} is not found. Probably it is not included.`};
    }

    let parentsAreGraphical = classes_[clss].parents.map((parent) => isGraphicalClass(parent));
    return parentsAreGraphical.some((isGraphical) => isGraphical);
}

function addQuotes(value) {
    const reRegex = /^\/[^\/]+\/[gmixXsuAJD]*$/;

    if (!reRegex.test(value) && value.charAt(0) !== '{' && value.charAt(0) !== '[' && value != parseInt(value) && value !== 'true' && value !== 'false') {
        value = `'${value.replace(/'/g, `\\'`)}'`;
    } else if (value === 'true') {
        value = true;
    } else if (value === 'false') {
        value = false;
    }

    return value;
}

function makeDirHierarchy(path) {
    let folders = path.split(/[\/\\]/);
    let currentPath = '';
    folders.forEach((folder) => {
        currentPath = path_.join(currentPath, folder);
        try {
            fs.mkdirSync(currentPath);
        } catch (e) {
        }
    });
}
