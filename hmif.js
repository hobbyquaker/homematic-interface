var pkg =           require('./package.json');
var async =         require('async');
var fs =            require('fs');
var path =          require('path');
var http =          require('http');
var xmlrpc =        require('homematic-xmlrpc');
var binrpc =        require('binrpc');
var util =          require('util');
var EventEmitter =  require('events').EventEmitter;
var pjson =         require('persist-json')('hmif');
var checkservice =  require('checkservice');

// http://www.eq-3.de/Downloads/eq3/download%20bereich/hm_web_ui_doku/HM_XmlRpc_API.pdf
// http://www.eq-3.de/Downloads/eq3/download%20bereich/hm_web_ui_doku/HMIP_XmlRpc_API_Addendum.pdf


function Hmif(config, status, log) {
    if (!(this instanceof Hmif)) return new Hmif(config, status, log);

    if (!log) {
        log = {};
        log.debug = log.info = log.warn = log.error = log.setLevel = function () {};
    }

    var that = this;
    this.status = status;
    this.status.homematic = {interfaces: {}};
    if (!config) return;

    this.config = config;

    if (!this.config.verbosity) this.config.verbosity = 'silent';

    log.setLevel(this.config.verbosity);
    log.info(pkg.name + ' ' + pkg.version + ' starting');

    this._iface = {};
    this._values = {};
    this._paramsetDescriptions = pjson.load('paramsetDescriptions.json') || {};
    this._names = {};

    var xmlrpcServer;
    var binrpcServer;

    function meta(params) {
        var iface = params[0];
        var address = params[1];
        var datapoint = params[2];
        var value = params[3];
        var dev = that._iface[iface].devices[address];
        var ident = paramsetIdent(dev, 'VALUES');
        var desc = that._paramsetDescriptions[ident][datapoint];
        var meta = {

        };
        if (address.indexOf(':') !== -1) {
            meta.channelName = that._names[address];
            meta.deviceName = that._names[address.replace(/:[0-9]+$/, '')];
        } else {
            meta.deviceName = that._names[address.replace(/:[0-9]+$/, '')];
        }
        if (desc.TYPE === 'ENUM') meta.enumValue = desc.VALUE_LIST[value];
        return meta;
    }


    function paramsetIdent(dev, paramset) {
        var ident = '';
        if (dev.PARENT_TYPE) ident = ident + dev.PARENT_TYPE + '/';
        ident = ident + dev.TYPE;
        if (dev.SUBTYPE) ident = ident + '/' + dev.SUBTYPE;
        ident = ident + '/' + dev.VERSION + '/' + paramset;
        return ident;
    }

    function getParamsetDescriptions(iface) {
        var calls = [];
        var requests = [];
        Object.keys(that._iface[iface].devices).forEach(function (address) {
            var dev = that._iface[iface].devices[address];
            dev.PARAMSETS.forEach(function (paramset) {
                var ident = paramsetIdent(dev, paramset);
                if ((!that._paramsetDescriptions[ident]) && (requests.indexOf(ident) === -1)) {
                    requests.push(ident);
                    calls.push(function (cb) {
                        log.debug('getParamsetDescription', ident);
                        that._iface[iface].rpc.methodCall('getParamsetDescription', [dev.ADDRESS, paramset], function (err, res) {
                            if (!err) {
                                that._paramsetDescriptions[ident] = res;
                            } else {
                                log.error(err);
                            }
                            cb();
                        });
                    });
                }
            })
        });
        async.series(calls, function () {
            log.debug('getParamsetDescriptions', iface, 'done');
            pjson.save('paramsetDescriptions.json', that._paramsetDescriptions);
        });
    }

    this.methods = {

        'system.multicall': function multicall(err, params, callback) {
            log.debug('rpc < system.multicall', err, '(' + params[0].length + ')');
            var res = [];
            params[0].forEach(function (c) {
                that.methods.event(null, c.params);
                res.push('');
            });
            log.debug('re  >', null, res);
            callback(null, res);
        },

        'system.listMethods': function listMethods(err, params, callback) {
            log.debug('rpc < system.listMethods', err, params);
            log.debug('re  >', null, JSON.stringify(Object.keys(that.methods)));
            callback(null, Object.keys(that.methods));
        },

        'event': function event(err, params, callback) {
            log.debug('rpc < event', err, params);
            that._iface[params[0]].lastEvent = (new Date()).getTime();
            if (params[1] === 'CENTRAL' && params[2] === 'PONG') return;
            if (!that._values[params[0]][params[1]]) {
                that._values[params[0]][params[1]] = {};
            }
            if (params[3] !== that._values[params[0]][params[1]][params[2]]) {
                log.info('rpc < change', err, params, that._names[params[1]]);

                if (params[1].indexOf(':') === -1) {
                    that.emit('change', params, meta(params));
                } else {
                    that.emit('change', params, meta(params));
                }
            }
            that._values[params[0]][params[1]][params[2]] = params[3];
            if (params[1].indexOf(':') === -1) {
                that.emit('rpc', 'event', params, meta(params));
            } else {
                that.emit('rpc', 'event', params, meta(params));
            }
            if (typeof callback === 'function') {
                log.debug('re  >', null, JSON.stringify(''));
                callback(null, '');
            }
        },


        'listDevices': function listDevices(err, params, callback) {
            log.debug('rpc < listDevices', err, params);
            var re = [];

            Object.keys(that._iface[params[0]].devices).forEach(function (d) {
                var dev = that._iface[params[0]].devices[d];
                if (that._iface[params[0]].type === 'hmip') {
                    re.push({'ADDRESS': dev.ADDRESS, 'VERSION': dev.VERSION});
                } else {
                    re.push({'ADDRESS': dev.ADDRESS, 'VERSION': dev.VERSION});
                }
            });

            log.debug('re  >', null, re.length);
            callback(null, re);
        },

        'newDevices': function newDevices(err, params, callback) {
            log.debug('rpc < newDevices', err, params[0], params[1]); //.length);
            that.emit('rpc', 'newDevices', params);

            params[1].forEach(function (dev) {
                that._iface[params[0]].devices[dev.ADDRESS] = dev;
            });

            pjson.save(that._iface[params[0]].host + '-' + that._iface[params[0]].port + '-devices.json', that._iface[params[0]].devices);
            log.debug('re  >', null, JSON.stringify(''));
            callback(null, '');
            getParamsetDescriptions(params[0]);
        },

        'deleteDevices': function deleteDevices(err, params, callback) {
            log.debug('rpc < deleteDevices', err, params[0], params[1].length);
            params[1].forEach(function (dev) {
                delete that._iface[params[0]].devices[dev.ADDRESS];
            });
            pjson.save(that._iface[params[0]].host + '-' + that._iface[params[0]].port + '-devices.json', that._iface[params[0]].devices);
            that.emit('rpc', 'deleteDevices', params);
            log.debug('re  >', null, JSON.stringify(''));
            callback(null, '');
        }

    };

    function getRegaNames() {
        log.debug('rega > reganames.fn');
        that.regaFile('regascripts/reganames.fn', function (err, res) {
            if (!err) {
                that._names = res;
                log.debug('rega < ' + Object.keys(res).length);
            } else {
                log.error(err);
            }
        });
    }

    function createClients(callback) {
        if (!that.config.type) return;
        switch (that.config.type.toLowerCase()) {
            case 'ccu':
            case 'ccu2':

                getRegaNames();
                createBinrpcServer();
                createInterface('rf', that.config.address, 2001, 'rf', 'binrpc', 90000);
                checkservice(that.config.address, 2000, function (err) {
                    if (!err) createInterface('wired', that.config.address, 2000, 'wired', 'binrpc', 90000);
                });
                checkservice(that.config.address, 2010, function (err) {
                    createXmlrpcServer();
                    if (!err) createInterface('hmip', that.config.address, 2010, 'hmip', 'xmlrpc', 0);
                });
                checkservice(that.config.address, 8701, function (err) {
                    if (!err) createInterface('cux', that.config.address, 8701, 'cux', 'binrpc', 0);
                });
                break;

            case 'hmipserver':
            case 'hmip':
                that._names = pjson.load(this.config.address + '-names.json') || {};
                createXmlrpcServer();
                createInterface(that.config.type, that.config.address, that.config.port || 2010, 'hmip', 'xmlrpc', 0);
                break;

            case 'hs485d':
            case 'wired':
                that._names = pjson.load(this.config.address + '-names.json') || {};

                if (that.config.protocol === 'binrpc') {
                    createBinrpcServer();
                } else {
                    createXmlrpcServer();
                }
                createInterface(that.config.type, that.config.address, that.config.port || 2000, 'wired', that.config.protocol, that.config.iface.checkEventTime);
                break;

            case 'rfd':
            case 'rf':
                that._names = pjson.load(this.config.address + '-names.json') || {};

                if (that.config.protocol === 'binrpc') {
                    createBinrpcServer();
                } else {
                    createXmlrpcServer();
                }
                createInterface(that.config.type, that.config.address, that.config.port || 2001, 'rf', that.config.protocol, that.config.iface.checkEventTime);
                break;

            case 'cuxd':
            case 'cux':
                that._names = pjson.load(this.config.address + '-names.json') || {};

                createBinrpcServer();
                createInterface(that.config.type, that.config.address, that.config.port || 8701, 'cux', 'binrpc', that.config.iface.checkEventTime);
                break;

            default:
                log.error('unknown interface type ' + that.config.interfaces[i].type + ' for ')
        }
        setTimeout(callback, 2500);
    }

    function createInterface(id, host, port, type, protocol, checkEventTime) {
        log.debug('creating interface', id, host + ':' + port);
        that._iface[id] = {
            init: false,
            host: host,
            port: port,
            protocol: protocol,
            type: type,
            devices: pjson.load(host + '-' + port + '-devices.json') || {},
            values: {},
            lastEvent: (new Date()).getTime(),
            checkEventTime: (typeof checkEventTime === 'undefined' ? 30000 : checkEventTime)
        };
        that.status.homematic.interfaces[id] = {
            init: false,
            host: host,
            port: port,
            protocol: protocol,
            type: type,
            checkEventTime: (typeof checkEventTime === 'undefined' ? 30000 : checkEventTime)
        };
        that._values[id] = {};

        switch (protocol) {
            case 'binrpc':
            case 'xmlrpc_bin':
                log.debug('binrpc.createClient', host + ':' + port);
                that._iface[id].rpc = binrpc.createClient({
                    host: host,
                    port: port
                });
                break;
            default:
                log.debug('xmlrpc.createClient', host + ':' + port);
                that._iface[id].rpc = xmlrpc.createClient({
                    host: host,
                    port: port,
                    path: '/'
                });
                break;
        }
    }

    function getIfaceInfos(callback) {
        var calls = [];
        Object.keys(that._iface).forEach(function (i) {
            var url = 'http://' + that.config.listenAddress + ':' + that.config.listenPort;

            log.debug('rpc >', i, 'system.listMethods', JSON.stringify([]));
            calls.push(function (cb) {
                that._iface[i].rpc.methodCall('system.listMethods', [], function (err, res) {
                    log.debug('re  <', i, err, JSON.stringify(res));
                    that._iface[i].methods = res;

                    if (res.indexOf('getVersion') !== -1) {
                        log.debug('rpc >', i, 'getVersion', []);
                        that._iface[i].rpc.methodCall('getVersion', [], function (err, res) {
                            log.debug('re  <', i, err, JSON.stringify(res));
                            that._iface[i].version = res;
                            cb();
                        });
                    } else {
                        cb();
                    }
                });
            });
        });
        async.series(calls, callback);
    }

    function subscribe(callback) {
        var calls = [];
        Object.keys(that._iface).forEach(function (i) {
            var url = 'http://' + that.config.listenAddress + ':' + that.config.listenPort;
            var params = [url, i];

            calls.push(function (cb) {
                log.debug('rpc >', i, 'init', params);
                that._iface[i].rpc.methodCall('init', params, function (err, res) {
                    log.debug('re  <', i, err, JSON.stringify(res));
                    if (!err) that.status.homematic.interfaces[i].init = true;
                    checkEvents(i);
                    cb();
                });
            });
        });
        async.series(calls, callback);
    }

    function checkEvents(iface) {
        if (!that._iface[iface].checkEventTime) {
            log.warn('no checkEventTime for ' + iface);
            that.status.homematic.interfaces[iface].checkEventTime = null;
            return;
        }
        that.status.homematic.interfaces[iface].checkEventTime = that._iface[iface].checkEventTime;
        that._iface[iface].checkEventInterval = setInterval(function () {
            var now = (new Date()).getTime();
            var le = that._iface[iface].lastEvent;
            var elapsed = now - le;
            log.debug('checkEvents', now, le, elapsed);

            if (elapsed > (2 * that._iface[iface].checkEventTime)) {
                that.status.homematic.interfaces[iface].init = false;
                var url = 'http://' + that.config.listenAddress + ':' + that.config.listenPort;
                var params = [url, iface];
                log.debug('rpc >', iface, 'init', params);
                that._iface[iface].rpc.methodCall('init', params, function (err, res) {
                    that._iface[iface].lastEvent = (new Date()).getTime();
                    log.debug('re  <', iface, err, JSON.stringify(res));
                });
            } else if ((now - that._iface[iface].lastEvent) > that._iface[iface].checkEventTime) {
                if (that._iface[iface].methods.indexOf('ping') !== -1) {
                    log.debug('rpc >', iface, 'ping', [iface]);
                    that._iface[iface].rpc.methodCall('ping', [iface], function (err, res) {
                        log.debug('re  <', iface, err, JSON.stringify(res));
                    });
                } else {
                    // how to provoke event without ping?
                }
            }
        }, (that._iface[iface].checkEventTime / 2));
    }

    function createXmlrpcServer() {
        xmlrpcServer = xmlrpc.createServer({host: that.config.listenAddress, port: that.config.listenPort});
        log.info('xmlrpc server listening on ' + that.config.listenAddress + ':' + that.config.listenPort);

        xmlrpcServer.on('NotFound', function (method, params) {
            log.warn('rpc < Method ' + method + ' does not exist', params);
        });
        that.status.homematic.xmlrpcServer = true;
        that.status.homematic.xmlrpcServerPort = that.config.listenPort;
        that.status.homematic.xmlrpcServerAddress = that.config.listenAddress;

        createHandlers(xmlrpcServer);

    }

    function createBinrpcServer() {
        binrpcServer = binrpc.createServer({host: that.config.listenAddress, port: that.config.listenPortBin});
        log.info('binrpc server listening on ' + that.config.listenAddress + ':' + that.config.listenPortBin);
        that.status.homematic.binrpcServer = true;
        that.status.homematic.binrpcServerPort = that.config.listenPort;
        that.status.homematic.binrpcServerAddress = that.config.listenAddress;
        createHandlers(binrpcServer);
    }

    function createHandlers(server) {
        Object.keys(that.methods).forEach(function (m) {
            server.on(m, that.methods[m]);
        });
    }

    createClients(function () {
        getIfaceInfos(function () {
            log.debug('getIfaces done');
            subscribe(function () {
                log.debug('subscriptions done');
            });
        });
    });



}

Hmif.prototype.rpc = function rpc(iface, method, params, callback) {
    this._iface[iface].rpc.methodCall(method, params, function (err, res) {
        if (typeof callback === 'function') callback(err, res);
    });
};


Hmif.prototype.rega = function rega(script, callback) {

    var post_options = {
        host: this.config.address,
        port: '8181',
        path: '/rega.exe',
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': script.length
        }
    };
    var post_req = http.request(post_options, function(res) {
        var data = '';
        res.setEncoding('utf8');
        res.on('data', function (chunk) {
            data += chunk.toString();
        });
        res.on('end', function () {
            var pos = data.lastIndexOf("<xml>");
            var stdout = unescape(data.substring(0, pos));
            try {
                var result = stdout;
                callback(null, result);
            } catch (e) {
                callback(e)

            }
        });
    });

    post_req.on('error', function (e) {
        callback(e);
    });

    post_req.write(script);
    post_req.end();



};

Hmif.prototype.regaFile = function regaFile(file, callback) {
    var that = this;
    fs.readFile(path.join(__dirname, file), 'utf8', function (err, script) {
        if (err) {
            callback(err);
            return false;
        }

        that.rega(script, function (err, res) {
            if (!err) {
                try {
                    callback(null, JSON.parse(res));
                } catch (e) {
                    callback(e);
                }
            } else {
                callback(err);
            }
        });

    });
};

Hmif.prototype._findIface = function findIface(address) {
    for (var i in this._iface) {
        for (var a in this._iface[i].devices) {
            if (a === address) return i;
        }
    }
};

Hmif.prototype.setValue = function rpc(address, datapoint, value, callback) {

    var iface = this._findIface(address);
    if (!iface) {
        callback(new Error('no suitable interface found for address ' + address));
    } else {
        this._iface[iface].rpc.methodCall('setValue', [address, datapoint, value], function (err, res) {
            if (typeof callback === 'function') callback(err, res);
        });
    }
};

Hmif.prototype.unsubscribe = function unsubscribe(callback) {
    var that = this;
    var calls = [];

    if (that._iface) {

        Object.keys(that._iface).forEach(function (i) {
            var url = 'http://' + that.config.listenAddress + ':' + that.config.listenPort;
            var params = [url, ''];

            log.debug('rpc >', i, 'init', params);
            calls.push(function (cb) {
                that._iface[i].rpc.methodCall('init', params, function (err, res) {
                    log.debug('re  <', i, err, JSON.stringify(res));
                    cb();
                });
            });
        });
        async.series(calls, callback);
    } else {
        callback();
    }
};

util.inherits(Hmif, EventEmitter);

module.exports = Hmif;