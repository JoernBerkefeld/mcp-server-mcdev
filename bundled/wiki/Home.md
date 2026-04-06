[![view on npm](https://badgen.net/github/release/Accenture/sfmc-devtools)](https://www.npmjs.org/package/mcdev)
[![view on npm](https://badgen.net/npm/node/mcdev)](https://www.npmjs.org/package/mcdev)
[![license](https://badgen.net/npm/license/mcdev)](https://www.npmjs.org/package/mcdev)
[![npm module downloads](https://badgen.net/npm/dt/mcdev)](https://www.npmjs.org/package/mcdev)
[![GitHub closed issues](https://badgen.net/github/closed-issues/Accenture/sfmc-devtools)](https://github.com/Accenture/sfmc-devtools/issues?q=is%3Aissue+is%3Aclosed)
[![GitHub releases](https://badgen.net/github/releases/Accenture/sfmc-devtools)](https://github.com/Accenture/sfmc-devtools/releases)

Accenture Salesforce Marketing Cloud DevTools (mcdev) is a rapid deployment/rollout, backup and development tool for Salesforce Marketing Cloud. It allows you to retrieve and deploy configuration and code across Business Units and instances.

## Requirements

- **Node.js**: `^20.19.0 || ^22.13.0 || >=24` (LTS versions recommended)
- **Git**: Any recent version

## Quick start

### Install

Run the following to install Accenture SFMC DevTools on your computer:

```bash
npm install -g mcdev
```

A more detailed guide on installing mcdev is in the [Getting Started section](/Accenture/sfmc-devtools/wiki/02.-Getting-Started) of this wiki.

### VSCode Extension

We also provide a [VSCode extension](https://marketplace.visualstudio.com/items?itemName=Accenture-oss.sfmc-devtools-vscode) that integrates SFMC DevTools into your IDE. You can install it from the [VSCode Marketplace](https://marketplace.visualstudio.com/items?itemName=Accenture-oss.sfmc-devtools-vscode).

### Include in your package

First, install it as a dependency:

```bash
npm install mcdev --save
```

You can then include it in your code with JavaScript/ES module imports:

```javascript
import mcdev from 'mcdev';
```

That will load `node_packages/mcdev/lib/index.js`. It can make sense to directly include other files if you have a special scenario. We've done that in our example for [retrieveChangelog.js](/Accenture/sfmc-devtools/blob/main/lib/retrieveChangelog.js) or in more detail, in our child-project [sfmc-devtools-copado](/Accenture/sfmc-devtools-copado) to get full control over certain aspects.

> :warning: **Note: The CommonJS module format `const mcdev = require('mcdev')` is no longer supported starting with version 6.0.0 of mcdev! Use ES module imports instead.**

If you want to hook into some of the internals, importing the type classes and there definitions might come in handy:

```javascript
import mcdevDefinition from 'mcdev/lib/MetadataTypeDefinitions';
import mcdevType from 'mcdev/lib/MetadataTypeInfo';

const DataExtension = mcdevType.dataExtension;
const dataExtensionConfig = mcdevDefinition.dataExtension;
```

Internal type declarations are usable via this import:

```javascript
import types from 'mcdev/types/mcdev.d';
```

## Documentation

Please check out the navigation bar to the right of this text for the full documentation.

## Changelog

Find info on the latest releases with a detailed changelog in the [GitHub Releases tab](https://github.com/Accenture/sfmc-devtools/releases).

## Contribute

If you want to enhance Accenture SFMC DevTools, you can fork the repo and create a pull request. Please understand that we must conduct a code review before accepting your changes.

More details on how to best do that are described in our [wiki](https://github.com/Accenture/sfmc-devtools/wiki/10.-Contribute).

## Main Contacts

The people that lead this project:

<table><tbody><tr><td align="center" valign="top" width="11%">
<a href="https://www.linkedin.com/in/joernberkefeld/">
<img src="https://github.com/JoernBerkefeld.png" width="250" height="250"><br />
<b>Jörn Berkefeld</b>
</a><br>
<a href="https://github.com/JoernBerkefeld">GitHub profile</a>
</td><td align="center" valign="top" width="11%">
<a href="https://www.linkedin.com/in/douglasmidgley/">
<img src="https://github.com/DougMidgley.png" width="250" height="250"><br />
<b>Doug Midgley</b>
</a><br>
<a href="https://github.com/DougMidgley">GitHub profile</a>
</td></tr></tbody></table>
