// Browser class for the WebExtensions API.
// After Firefox moved to WebExtensions this is the only API we use. Still as a
// good practice we keep all API-specific code here.
// For documentation of the various methods, see browser_base.js
//
const Browser = require('./browser_base');
const Util = require('./util');

Browser.init = function(script) {
	Browser._script = script;

	switch(script) {
		case 'main':
			this._main_script();
			break;

		case 'content':
			break;
	}
};

// all browser-specific code that runs in the main script goes here
//
Browser._main_script = function() {
	// fire browser.install/update events
	//
	browser.runtime.onInstalled.addListener(function(details) {
		if(details.reason == "install")
			Util.events.fire('browser.install');

		else if(details.reason == "update")
			Util.events.fire('browser.update');
	});

	// some operations cannot be done by other scripts, so we set
	// handlers to do them in the main script
	//
	Browser.rpc.register('refreshIcon', async function(tabId, callerTabId) {
		// 'self' tabId in the content script means refresh its own tab
		await Browser.gui.refreshIcon(tabId == 'self' ?  callerTabId : tabId);
	});

	Browser.rpc.register('closeTab', function(tabId) {
		browser.tabs.remove(tabId);
	});

	// Workaroud some Firefox page-action 'bugs' (different behaviour than chrome)
	// - the icon is _not_ hidden automatically on refresh
	// - [android-only] the icon is _not_ hidden when navigating away from a page
	// - the icon _is_ hidden on history.pushstate (eg on google maps when
	//   clicking on some label) although the same page remains loaded
	//
	if(!Browser.capabilities.needsPAManualHide()) {
		Browser.gui.iconShown = {};

		browser.tabs.onUpdated.addListener(function(tabId, info) {
			// minimize overhead: only act if we have shown an icon in this tab before
			if(!Browser.gui.iconShown[tabId]) return;

			if(info.status == 'loading')
				// tab is loading, make sure the icon is hidden
				browser.pageAction.hide(tabId);
			else if(info.status == 'complete')
				// this fires after history.pushState. Call refreshIcon to reset
				// the icon if it was incorrectly hidden
				Browser.gui.refreshIcon(tabId);
		});
	}

	// set default icon (for browser action)
	//
	Browser.gui.refreshAllIcons();
}


//////////////////// rpc ///////////////////////////
//
//
Browser.rpc.register = function(name, handler) {
	// set onMessage listener if called for first time
	if(!this._methods) {
		this._methods = {};
		browser.runtime.onMessage.addListener(this._listener);
	}
	this._methods[name] = handler;
}

// onMessage listener. Received messages are of the form
// { method: ..., args: ... }
//
Browser.rpc._listener = function(message, sender, replyHandler) {
	Browser.log("RPC: got message", [message, sender, replyHandler]);

	var handler = Browser.rpc._methods[message.method];
	if(!handler) return;

	// add tabId and replyHandler to the arguments
	var args = message.args || [];
	var tabId = sender.tab ? sender.tab.id : null;
	args.push(tabId);

	const res = handler.apply(null, args);
	if(res instanceof Promise) {
		// handler returned a Promise. We return true here, to indicate that the response will come later.
		res.then(replyHandler);
		return true;
	} else {
		// We have a response right now
		replyHandler(res);
		return false;
	}
};

Browser.rpc.call = async function(tabId, name, args) {
	return new Promise(resolve => {
		var message = { method: name, args: args };
		if(tabId)
			browser.tabs.sendMessage(tabId, message, resolve);
		else
			browser.runtime.sendMessage(null, message, resolve);
	});
}


//////////////////// storage ///////////////////////////
//
// implemented using browser.storage.local
//
// Note: browser.storage.local can be used from any script (main, content,
//       popup, ...) and it always accesses the same storage, so no rpc
//       is needed for storage!
//
Browser.storage._key = "global";	// store everything under this key

Browser.storage.get = async function() {
	return new Promise(resolve => {
		browser.storage.local.get(Browser.storage._key, function(items) {
			var st = items[Browser.storage._key];

			// default values
			if(!st) {
				st = Browser.storage._default;
				Browser.storage.set(st);
			}
			resolve(st);
		});
	});
};

Browser.storage.set = async function(st) {
	return new Promise(resolve => {
		Browser.log('saving st', st);
		var items = {};
		items[Browser.storage._key] = st;
		browser.storage.local.set(items, resolve);
	});
};

Browser.storage.clear = async function() {
	return new Promise(resolve => {
		browser.storage.local.clear(resolve);
	});
};


//////////////////// gui ///////////////////////////
//
//
Browser.gui.refreshIcon = async function(tabId) {
	// delegate the call to the 'main' script if:
	// - we're in 'content': browser.pageAction/browserAction is not available there
	// - we use the FF pageAction workaround: we need to update Browser.gui.iconShown in 'main'
	//
	if(Browser._script == 'content' ||
	   (Browser._script != 'main' && Browser.capabilities.needsPAManualHide())
	) {
		await Browser.rpc.call(null, 'refreshIcon', [tabId]);
		return;
	}

	const info = await Util.getIconInfo(tabId);
	if(Browser.capabilities.permanentIcon())
		await Browser.gui._refreshBrowserAction(tabId, info);
	else
		await Browser.gui._refreshPageAction(tabId, info);
};

Browser.gui._icons = function(private) {
	var sizes = Browser.capabilities.supportedIconSizes();
	var ret = {};
	for(var i = 0; i < sizes.length; i++)
		ret[sizes[i]] = '/images/pin_' + (private ? '' : 'disabled_') + sizes[i] + '.png';
	return ret;
}

Browser.gui._refreshPageAction = function(tabId, info) {
	if(info.hidden || info.apiCalls == 0) {
		browser.pageAction.hide(tabId);
		return;
	}

	return new Promise(resolve => {
		if(Browser.gui.iconShown)
			Browser.gui.iconShown[tabId] = 1;

		browser.pageAction.setPopup({
			tabId: tabId,
			popup: "popup.html?tabId=" + tabId		// pass tabId in the url
		});
		browser.pageAction.show(tabId);

		browser.pageAction.setTitle({
			tabId: tabId,
			title: info.title
		});
		browser.pageAction.setIcon({
			tabId: tabId,
			path: Browser.gui._icons(info.private)
		}, resolve);		// setIcon is the only pageAction.set* method with a callback
	});
}

Browser.gui._refreshBrowserAction = function(tabId, info) {
	return new Promise(resolve => {
		browser.browserAction.setTitle({
			tabId: tabId,
			title: info.title
		});
		browser.browserAction.setBadgeText({
			tabId: tabId,
			text: (info.apiCalls || "").toString()
		});
		browser.browserAction.setBadgeBackgroundColor({
			tabId: tabId,
			color: "#b12222"
		});
		browser.browserAction.setPopup({
			tabId: tabId,
			popup: "popup.html" + (tabId ? "?tabId="+tabId : "")	// pass tabId in the url
		});
		browser.browserAction.setIcon({
			tabId: tabId,
			path: Browser.gui._icons(info.private)
		}, resolve);		// setIcon is the only browserAction.set* method with a callback
	});
}

Browser.gui.refreshAllIcons = async function() {
	return new Promise(resolve => {
		browser.tabs.query({}, async function(tabs) {
			// for browser action, also refresh default state (null tabId)
			if(Browser.capabilities.permanentIcon())
				tabs.push({ id: null });

			for(var i = 0; i < tabs.length; i++)
				await Browser.gui.refreshIcon(tabs[i].id);

			resolve();
		});
	});
};

Browser.gui.showPage = function(name) {
	browser.tabs.create({ url: browser.extension.getURL(name) });
};

Browser.gui.getCallUrl = async function(tabId) {
	async function getActiveTabId() {
		return new Promise(resolve => {
			browser.tabs.query({
				active: true,               // Select active tabs
				lastFocusedWindow: true     // In the current window
			}, async function(tabs) {
				resolve(tabs[0].id);
			});
		})
	}

	if(!tabId)
		tabId = await getActiveTabId();

	// we call getState from the content script
	const state = await Browser.rpc.call(tabId, 'getState', []);
	return state && state.callUrl;		// state might be null if no content script runs in the tab
};

Browser.gui.closePopup = function() {
	if(Browser._script != 'popup') throw "only called from popup";

	if(Browser.capabilities.popupAsTab())
		// popup is shown as a normal tab so window.close() doesn't work. Call closeTab in the main script
		Browser.rpc.call(null, 'closeTab', []);
	else
		// normal popup closes with window.close()
		window.close();
}

Browser.gui.getURL = function(url) {
	return browser.runtime.getURL(url);
}

// Browser.gui.mapTiles = function() {
// 	return {
// 		url: Browser.capabilities.isBrave()
// 			? 'https://{s}.tile.openstreetmap.de/{z}/{x}/{y}.png'
// 			: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
// 		info: { attribution: 'Map data © OpenStreetMap contributors' }
// 	};
// }


//////////////////// capabilities ///////////////////////////
//
//
Browser.capabilities.isDebugging = function() {
	// update_url is only present if the extensioned is installed via the web store
	if(Browser.debugging == null)
		Browser.debugging = !('update_url' in browser.runtime.getManifest());
	return Browser.debugging;
}

Browser.capabilities.popupAsTab = function() {
	// Firefox@Android shows popup as normal tab
	return this._build == 'firefox' && this.isAndroid();
}

Browser.capabilities.needsPAManualHide = function() {
	// Workaroud some Firefox page-action 'bugs'
	return this._build == 'firefox';
}

Browser.capabilities.logInBackgroundPage = function() {
	return this._build == 'chrome';
}

// True: a geolocation call in an iframe appears (eg in the permission dialog) to come from the iframe's domain
// False: a geolocation call in an iframe appears to come from the top page's domain
//
Browser.capabilities.iframeGeoFromOwnDomain = function() {
	return this._build == 'firefox';
}

Browser.capabilities.permanentIcon = function() {
	// we use browserAction in browsers where pageAction is not properly supported (eg Chrome)
	return !!browser.runtime.getManifest().browser_action;
}

Browser.capabilities.supportedIconSizes = function() {
	return [16, 19, 20, 32, 38, 40, 64];
}


Browser.log = function() {
	if(!Browser.capabilities.isDebugging()) return;

	console.log.apply(console, arguments);

	// in chrome, apart from the current console, we also log to the background page, if possible and loaded
	//
	if(Browser.capabilities.logInBackgroundPage()) {
		var bp;
		if(browser.extension && browser.extension.getBackgroundPage)
			bp = browser.extension.getBackgroundPage();

		if(bp && bp.console != console)		// avoid logging twice
			bp.console.log.apply(bp.console, arguments);
	}
}

module.exports = Browser;
