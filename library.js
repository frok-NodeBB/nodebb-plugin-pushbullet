"use strict";

var db = module.parent.require('./database'),
	meta = module.parent.require('./meta'),
	user = module.parent.require('./user'),
	translator = module.parent.require('../public/src/translator'),
	SocketPlugins = module.parent.require('./socket.io/plugins'),

	winston = module.parent.require('winston'),
	nconf = module.parent.require('nconf'),
	async = module.parent.require('async'),
	request = module.parent.require('request'),
	S = module.parent.require('string'),
	querystring = require('querystring'),
	cache = require('lru-cache'),
	lang_cache = undefined,

	constants = Object.freeze({
		authorize_url: 'https://www.pushbullet.com/authorize',
		push_url: 'https://api.pushbullet.com/v2/pushes'
	}),

	Pushbullet = {};

Pushbullet.init = function(app, middleware, controllers) {
	var pluginMiddleware = require('./middleware'),
		pluginControllers = require('./controllers');

	// Admin setup routes
	app.get('/admin/plugins/pushbullet', middleware.admin.buildHeader, pluginControllers.renderACP);
	app.get('/api/admin/plugins/pushbullet', pluginControllers.renderACP);

	// Pushbullet-facing routes
	app.get('/pushbullet/setup', pluginMiddleware.hasConfig, Pushbullet.redirectSetup);
	app.get('/pushbullet/auth', pluginMiddleware.hasConfig, pluginMiddleware.hasCode, pluginMiddleware.isLoggedIn, Pushbullet.completeSetup, middleware.buildHeader, pluginControllers.renderAuthSuccess);
	// app.get('/user/:userslug/pushbullet', middleware.buildHeader, middleware.checkGlobalPrivacySettings, middleware.checkAccountPermissions, pluginControllers.renderSettings);
	// app.get('/api/user/:userslug/pushbullet', middleware.checkGlobalPrivacySettings, middleware.checkAccountPermissions, pluginControllers.renderSettings);
	app.get('/pushbullet/settings', middleware.buildHeader, pluginControllers.renderSettings);
	app.get('/api/pushbullet/settings', pluginMiddleware.isLoggedIn, pluginControllers.renderSettings);

	// Config set-up
	db.getObject('settings:pushbullet', function(err, config) {
		if (!err && config) {
			Pushbullet.config = config;
		} else {
			winston.info('[plugins/pushbullet] Please complete setup at `/admin/pushbullet`');
		}
	});

	// User language cache
	db.sortedSetCard('users:postcount', function(err, numUsers) {
		var	cacheOpts = {
				max: 50,
				maxAge: 1000 * 60 * 60 * 24
			};

		if (!err && numUsers > 0) cacheOpts.max = Math.floor(numUsers / 20);
		lang_cache = cache(cacheOpts);
	});

	// WebSocket listeners
	SocketPlugins.pushbullet = {
		settings: {
			save: Pushbullet.settings.save,
			load: Pushbullet.settings.load
		}
	};
};

Pushbullet.redirectSetup = function(req, res) {
	var qs = querystring.stringify({
			client_id: Pushbullet.config.id,
			redirect_uri: encodeURIComponent(nconf.get('url') + '/pushbullet/auth'),
			response_type: 'code'
		});

	res.redirect(constants.authorize_url + '?' + qs);
};

Pushbullet.completeSetup = function(req, res, next) {
	async.waterfall([
		function(next) {
			Pushbullet.retrieveToken(req.query.code, next);
		},
		function(token, next) {
			Pushbullet.saveToken(req.user.uid, token, next);
		}
	], next);
};

Pushbullet.push = function(notifObj) {
	// Determine whether the user will receive notifications via Pushbullet
	db.getObjectField('pushbullet:tokens', notifObj.uid, function(err, token) {
		if (token) {
			async.waterfall([
				function(next) {
					Pushbullet.getUserLanguage(notifObj.uid, next);
				},
				function(lang, next) {
					translator.translate(notifObj.text, lang, function(translated) {
						next(undefined, S(translated).stripTags().s);
					});
				},
				function(body, next) {
					var	payload = {
						type: 'link',
						title: 'New Notification from ' + (meta.config.title || 'NodeBB'),
						url: nconf.get('url') + notifObj.path,
						body: body
					}
					request.post(constants.push_url, {
						form: payload,
						auth: {
							user: token
						}
					}, function(err, request, result) {
						if (err) {
							winston.error(err);
						} else if (result.length) {
							try {
								result = JSON.parse(result);
								if (result.error) {
									winston.error('[plugins/pushbullet] ' + result.error.message + '(' + result.error.type + ')');
								}
							} catch (e) {
								winston.error(e);
							}
						}
					});
				}
			]);
		}
	});
};

Pushbullet.addMenuItem = function(custom_header, callback) {
	custom_header.plugins.push({
		"route": '/plugins/pushbullet',
		"icon": 'fa-mobile',
		"name": 'Pushbullet'
	});

	callback(null, custom_header);
};

Pushbullet.addProfileItem = function(links, callback) {
	links.push({
		id: 'pushbullet',
		route: '../../pushbullet/settings',
		icon: 'fa-mobile',
		name: 'Pushbullet',
		public: false
	});

	callback(null, links);
};

Pushbullet.retrieveToken = function(code, callback) {
	request.post('https://api.pushbullet.com/oauth2/token', {
		form: {
			grant_type: 'authorization_code',
			client_id: Pushbullet.config.id,
			client_secret: Pushbullet.config.secret,
			code: code
		}
	}, function(err, request, response) {
		if (!err && response.length) {
			try {
				response = JSON.parse(response);
				callback(undefined, response.access_token);
			} catch (err) {
				callback(err);
			}
			
		} else {
			callback(err || new Error(response.error.type));
		}
	});
};

Pushbullet.saveToken = function(uid, token, callback) {
	db.setObjectField('pushbullet:tokens', uid, token, callback);
};

Pushbullet.getUserLanguage = function(uid, callback) {
	if (lang_cache.has(uid)) {
		callback(null, lang_cache.get(uid));
	} else {
		user.getSettings(uid, function(err, settings) {
			var language = settings.language || meta.config.defaultLang || 'en_GB';
			callback(null, language);
			lang_cache.set(uid, language);
		});
	}
};

/* Settings */
Pushbullet.settings = {};

Pushbullet.settings.save = function(socket, data, callback) {
	if (socket.hasOwnProperty('uid') && socket.uid > 0) {
		db.setObject('user:' + socket.uid + ':settings', data, callback);
	} else {
		callback(new Error('not-logged-in'));
	}
};

Pushbullet.settings.load = function(socket, data, callback) {
	if (socket.hasOwnProperty('uid') && socket.uid > 0) {
		db.getObjectFields('user:' + socket.uid + ':settings', ['pushbullet:enabled'], callback);
	} else {
		callback(new Error('not-logged-in'));
	}
};

module.exports = Pushbullet;