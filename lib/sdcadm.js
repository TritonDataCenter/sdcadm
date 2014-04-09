/*
 * Copyright (c) 2014, Joyent, Inc. All rights reserved.
 *
 * Core SdcAdm class.
 */

var assert = require('assert-plus');
var format = require('util').format;
var fs = require('fs');
var p = console.log;
var path = require('path');
var sdcClients = require('sdc-clients');

var vasync = require('vasync');

var common = require('./common');
var pkg = require('../package.json');



//---- SdcAdm class

/**
 * Create a SdcAdm.
 *
 * @param options {Object}
 *      - log {Bunyan Logger}
 */
function SdcAdm(options) {
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.optionalString(options.profile, 'options.profile');
    var self = this;

    //XXX
    //this.config = common.loadConfigSync();

    //XXX Still need this?
    // Until we have a smartdc using restify with mcavage/node-restify#498
    // we need client_res and client_req serializers.
    //this.log = options.log.child({
    //    serializers: restify.bunyan.serializers
    //});
    this.log = options.log;

    // TODO: pass in a req id header here?
    var userAgent = format('%s/%s', pkg.name, pkg.version);
    this.__defineGetter__('sapi', function () {
        if (self._sapi === undefined) {
            self._sapi = new sdcClients.SAPI({
                url: self.config.sapi.url,
                agent: false,
                userAgent: userAgent,
                log: self.log
            });
        }
        return self._sapi;
    });
    this.__defineGetter__('cnapi', function () {
        if (self._cnapi === undefined) {
            self._cnapi = new sdcClients.CNAPI({
                url: self.config.cnapi.url,
                agent: false,
                userAgent: userAgent,
                log: self.log
            });
        }
        return self._cnapi;
    });
    this.__defineGetter__('vmapi', function () {
        if (self._vmapi === undefined) {
            self._vmapi = new sdcClients.VMAPI({
                url: self.config.vmapi.url,
                agent: false,
                userAgent: userAgent,
                log: self.log
            });
        }
        return self._vmapi;
    });
    this.__defineGetter__('imgapi', function () {
        if (self._imgapi === undefined) {
            self._imgapi = new sdcClients.IMGAPI({
                url: self.config.imgapi.url,
                agent: false,
                userAgent: userAgent,
                log: self.log
            });
        }
        return self._imgapi;
    });
}


SdcAdm.prototype.init = function init(callback) {
    var self = this;
    common.loadConfig(function (err, config) {
        if (err) {
            return callback(err);
        }
        self.config = config;
        callback();
    });
};


/**
 * Gather a JSON object for each installed SDC component giving its id and
 * version.
 *
 * - For SDC core zones: uuid, component (alias), service, image_uuid,
 *   version, buildstamp (eventually).
 * - For agents (on each server): XXX
 * - For platforms (on each server): XXX
 * - For "mini-platform-upgrades", i.e. possible live-upgraded imgadm, etc.:
 *   XXX (TODO: get imgadm/vmadm/... live-upgradable info into sysinfo, and
 *   hence into CNAPI.)
 * - gz tools
 * - sdcadm itself
 *
 * All types will have these fields:
 *      component
 *      version
 *      buildstamp (eventually, TODO)
 *      server
 *      hostname
 */
SdcAdm.prototype.gatherComponentVersions = function gatherComponentVersions(
        options, cb) {
    var self = this;
    assert.object(options, 'options');
    assert.func(cb, 'cb');

    var comps = [];
    var serversFromUuid = {};
    vasync.parallel({funcs: [
        function getAgentsAndPlatforms(next) {
            var serverOpts = {
                extras: 'sysinfo'
            };
            self.cnapi.listServers(serverOpts, function (serversErr, servers) {
                if (serversErr) {
                    return next(serversErr);
                }
                servers.forEach(function (server) {
                    serversFromUuid[server.uuid] = server;

                    var sdcVersion = server.sysinfo['SDC Version'] || '6.5';
                    comps.push({
                        type: 'platform',
                        component: format('%s:platform', server.hostname),
                        version: format('%s:%s', sdcVersion,
                            server.current_platform),
                        role: 'platform',
                        sdc_version: sdcVersion,
                        platform: server.current_platform,
                        server: server.uuid,
                        hostname: server.hostname
                    });

                    (server.sysinfo['SDC Agents'] || []).forEach(
                            function (agent) {
                        comps.push({
                            type: 'agent',
                            component: format('%s:%s', server.hostname,
                                agent.name),
                            role: agent.name,
                            version: agent.version,
                            server: server.uuid,
                            hostname: server.hostname
                        })
                    });
                });
                next();
            });
        },
        function getCoreZones(next) {
            // 'cloudapi' zones typically don't have `tags.smartdc_core=true`
            // so we can't filter on that. And VMAPI doesn't support filtering
            // on presence of a tag (e.g. `smartdc_role`.)
            var filters = {
                state: 'active',
                owner_uuid: self.config.ufds_admin_uuid
            };
            self.vmapi.listVms(filters, function (vmsErr, vms) {
                if (vmsErr) {
                    return next(vmsErr);
                }
                vms = vms.filter(function (vm) {
                    return vm.tags && vm.tags.smartdc_role;
                })
                vasync.forEachParallel({
                    inputs: vms,
                    func: function addOneCoreZone(vm, nextVm) {
                        self.imgapi.getImage(vm.image_uuid, function (e, img) {
                            if (e) {
                                return nextVm(e);
                            }
                            comps.push({
                                type: 'zone',
                                component: vm.alias,
                                version: img.version,
                                uuid: vm.uuid,
                                role: vm.tags.smartdc_role,
                                image_uuid: vm.image_uuid,
                                server: vm.server_uuid,
                                hostname: serversFromUuid[vm.server_uuid].hostname
                            });
                            nextVm();
                        });
                    }
                }, next);
            });
        },
    ]}, function (err) {
        cb(err, comps);
    });
};


//---- exports

module.exports = SdcAdm;
