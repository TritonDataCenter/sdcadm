/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019 Joyent, Inc.
 *
 * Steps for doing some things with SAPI.
 */

var assert = require('assert-plus');
var fs = require('fs');
var util = require('util');
var vasync = require('vasync');

var errors = require('../errors');
var shared = require('../procedures/shared');

var DRY_RUN = false; // An off-switch for dev/testing.


/**
 * Ensure that SAPI has a service entry for the core agents.
 *
 * By "core" agents, we mean those installed by default on node setup
 * (which currently is those in the agentsshar) -- with the exception of the
 * marlin agent.
 *
 */
function ensureAgentServices(arg, cb) {
    assert.object(arg, 'arg');
    assert.func(arg.progress, 'arg.progress');
    assert.object(arg.log, 'arg.log');
    assert.object(arg.sdcadm, 'arg.sdcadm');
    assert.object(arg.sdcadm.sdcApp, 'arg.sdcadm.sdcApp');
    assert.func(cb, 'cb');

    var log = arg.log.child({component: 'sapiEnsureAgentServices'}, true);
    var sdcadm = arg.sdcadm;
    var progress = arg.progress;

    // We need at least a MIN_VALID_SAPI_VERSION image so
    // type=agent suport is there.
    var MIN_VALID_SAPI_VERSION = '20140703';
    var app = sdcadm.sdcApp;


    var img;
    var agentNames = [
        'agents_core',
        'amon-agent',
        'amon-relay',
        'cmon-agent',
        'cn-agent',
        'config-agent',
        'firewaller',
        'hagfish-watcher',
        'net-agent',
        'smartlogin',
        'vm-agent'
    ];
    var agentServices = {};
    agentNames.forEach(function (n) {
        var logLevelKey = n.toUpperCase().replace('-', '_') + '_LOG_LEVEL';
        agentServices[n] = {
            name: n,
            type: 'agent',
            params: {
                tags: {
                    smartdc_role: n,
                    smartdc_type: 'core'
                }
            },
            metadata: {
                SERVICE_NAME: n
            },
            manifests: {
            }
        };

        agentServices[n].metadata[logLevelKey] = 'info';
    });


    // The first time we add agent services to SAPI we'll use the HN image
    // version to create the service, assuming that's the version installed
    // everywhere across the whole SDC setup
    function getAgentImages(callback) {
        vasync.forEachPipeline({
            func: function (agent, next) {
                var name = agent.name;
                var imageUuidPath = '/opt/smartdc/agents/lib/node_modules/' +
                    name + '/image_uuid';
                fs.readFile(imageUuidPath, {
                    encoding: 'utf8'
                }, function (err, data) {
                    if (err) {
                        log.warn({err: err, name: name, path: imageUuidPath},
                            'could not read agent image_uuid file');
                        next();
                        return;
                    }
                    agentServices[name].params.image_uuid = data.trim();
                    next();
                });
            },
            inputs: agentNames.map(function (agent) {
                return agentServices[agent];
            })
        }, callback);
    }

    var newAgentServices = [];
    var updateAgentServices = [];

    vasync.pipeline({funcs: [
        function getSapiVmImgs(_, next) {
            sdcadm.getImgsForSvcVms({
                svc: 'sapi'
            }, function (err, obj) {
                if (err) {
                    return next(err);
                }
                img = obj.imgs[0];
                return next();
            });
        },

        function checkMinSapiVersion(_, next) {
            var splitVersion = img.version.split('-');
            var validSapi = false;

            if (splitVersion[0] === 'master') {
                validSapi = splitVersion[1].substr(0, 8) >=
                    MIN_VALID_SAPI_VERSION;
            } else if (splitVersion[0] === 'release') {
                validSapi = splitVersion[1] >= MIN_VALID_SAPI_VERSION;
            } else {
                progress('Warning: cannot verify that SAPI is at least of ' +
                    '%s vintage, because a non-master/non-release SAPI ' +
                    'image is being used.', MIN_VALID_SAPI_VERSION);
                validSapi = true;
            }

            if (!validSapi) {
                return next(new errors.SDCClientError(
                    new Error(util.format('SAPI in this datacenter is using ' +
                        'image version %s, which is not the minimum version ' +
                        'required for adding service agents (%s). Please ' +
                        'upgrade SAPI and then retry.', img.version,
                        MIN_VALID_SAPI_VERSION)),
                    'sapi'));
            }

            return next();
        },

        function checkExistingAgents(_, next) {
            vasync.forEachParallel({
                func: function checkAgentExist(agent, callback) {
                    sdcadm.sapi.listServices({
                        name: agent,
                        type: 'agent',
                        application_uuid: app.uuid
                    }, function (svcErr, svcs) {
                        if (svcErr) {
                            return callback(svcErr);
                        }
                        if (!svcs.length) {
                            newAgentServices.push(agent);
                        } else if (!svcs[0].params.image_uuid) {
                            agentServices[agent] = svcs[0];
                            updateAgentServices.push(agent);
                        }
                        return callback();
                    });
                },
                inputs: Object.keys(agentServices)
            }, next);
        },

        /*
         * TOOLS-1716: We'll create agents w/o image_uuids first, in order
         * to workaround SAPI verification of local IMGAPI images when creating
         * a service. Then, we'll queue these services for update, given SAPI's
         * update service will not validate the image uuids.
         *
         * This approach could be removed once SAPI-285 is implemented, and we
         * could save services including image_uuid from the beginning.
         */
        function addAgentsServices(_, next) {
            vasync.forEachParallel({
                inputs: newAgentServices,
                func: function addAgentSvc(agent, nextAgent) {
                    progress('Adding service for agent \'%s\'', agent);
                    log.trace({
                        service: agent,
                        params: agentServices[agent]
                    }, 'Adding new agent service');
                    if (DRY_RUN) {
                        nextAgent();
                    } else {
                        sdcadm.sapi.createService(agent, app.uuid,
                            agentServices[agent], function (sErr, newSvc) {
                                if (sErr) {
                                    nextAgent(sErr);
                                    return;
                                }
                                updateAgentServices.push(newSvc);
                                nextAgent();
                            });
                    }
                }
            }, next);
        },

        function getAgentImgVersions(_, next) {
            getAgentImages(next);
        },

        function updateAgentsServices(_, next) {
            vasync.forEachParallel({
                inputs: updateAgentServices,
                func: function updateAgentSvc(agent, callback) {
                    if (!agentServices[agent]) {
                        callback();
                        return;
                    }
                    log.trace({
                        service: agent,
                        params: agentServices[agent]
                    }, 'Updating agent service');
                    if (DRY_RUN) {
                        callback();
                    } else {
                        sdcadm.sapi.updateService(agentServices[agent].uuid, {
                            params: agentServices[agent].params
                        }, callback);
                    }
                }
            }, next);
        }
    ]}, cb);
}


function assertFullMode(arg, cb) {
    assert.object(arg, 'arg');
    assert.object(arg.sdcadm, 'arg.sdcadm');
    assert.func(cb, 'cb');

    arg.sdcadm.sapi.getMode(function (err, mode) {
        if (err) {
            cb(new errors.SDCClientError(err, 'sapi'));
        } else if (mode !== 'full') {
            cb(new errors.UpdateError(util.format(
                'SAPI is not in "full" mode: mode=%s', mode)));
        } else {
            cb();
        }
    });
}


/*
 * Every triton core instance has a value for 'params.alias' in SAPI
 * except sapi0 itself. This can make some functions which work with
 * aliases fail. Therefore we'll provide tooling for fixing such issue
 * when needed.
 *
 * HEAD-2384 should fix the root cause for this issue.
 *
 * @param {Object} arg: All the following arguments are required:
 * @param {Object} arg.sdcadm: sdcadm object instance
 * @param {Array} arg.instances: list of sapi service instances from SAPI.
 *
 * @param {Function} cb: Callback of the form f(err, instances);
 */

function fixInstanceAlias(arg, cb) {
    assert.object(arg, 'arg');
    assert.object(arg.sdcadm, 'arg.sdcadm');
    assert.array(arg.instances, 'arg.instances');
    assert.func(cb, 'cb');

    vasync.forEachPipeline({
        inputs: arg.instances,
        func: function fixAlias(instance, nextInstance) {
            if (!instance.uuid) {
                nextInstance(new errors.UsageError('Missing instance uuid'));
                return;
            }

            if (instance.params && instance.params.alias) {
                nextInstance();
                return;
            }

            arg.sdcadm.vmapi.getVm({
                uuid: instance.uuid
            }, function getVmCb(getVmErr, vm) {
                if (getVmErr)  {
                    nextInstance(new errors.SDCClientError(getVmErr, 'vmapi'));
                    return;
                }

                if (!vm.alias) {
                    nextInstance(new errors.InternalError(
                        'Unknown alias for instance ' + instance.uuid));
                    return;
                }

                arg.sdcadm.sapi.updateInstance(instance.uuid, {
                    action: 'update',
                    params: {
                        alias: vm.alias
                    }
                }, function sapiCb(sapiErr) {
                    var updateErr;
                    if (sapiErr) {
                        updateErr = new errors.SDCClientError(sapiErr, 'sapi');
                    }
                    nextInstance(updateErr);
                });
            });
        }
    }, function pipeCb(pipeErr) {
        if (pipeErr) {
            cb(pipeErr);
            return;
        }
        arg.sdcadm.sapi.listInstances({
            // instance.service_uuid is mandatory in SAPI, no need to check for
            // its existence here:
            service_uuid: arg.instances[0].service_uuid
        }, function listCb(listErr, updatedInstances) {
            if (listErr) {
                cb(new errors.SDCClientError(listErr, 'sapi'));
                return;
            }
            cb(null, updatedInstances);
        });
    });
}


function ensureAssetsService(arg, cb) {

    assert.object(arg, 'arg');
    assert.func(arg.progress, 'arg.progress');
    assert.object(arg.log, 'arg.log');
    assert.object(arg.sdcadm, 'arg.sdcadm');
    assert.object(arg.sdcadm.sdcApp, 'arg.sdcadm.sdcApp');
    assert.func(cb, 'cb');

    const app = arg.sdcadm.sdcApp;

    var registrarCfg = {
      registration: {
        domain: 'SERVICE_DOMAIN',
        type: 'rr_host',
        service: {
          type: 'service',
          service: {
            srvce: '_SERVICE_NAME',
            proto: '_tcp',
            ttl: 60,
            port: 80
          }
        },
        ttl: 60
      },
      zookeeper: {
        servers: [
          '{{ZK_SERVERS}}'
        ],
        timeout: 60000
      }
    };

    var serviceData = {
        name: 'assets',
        params: {
            package_name: 'sdc_128',
            billing_id: 'TO_FILL_IN', // filled in from 'package_name'
            image_uuid: 'TO_FILL_IN',
            archive_on_delete: true,
            delegate_dataset: true,
            maintain_resolvers: true,
            networks: [
                {name: 'admin', primary: true}
            ],
            firewall_enabled: false,
            tags: {
                smartdc_role: 'assets',
                smartdc_type: 'core'
            },
            filesystems: [ {
                source: '/usbkey/extra',
                target: '/assets/extra',
                type: 'lofs',
                options: [
                    'ro',
                    'nodevices'
                ]
            }, {
                source: '/usbkey/os',
                target: '/assets/os',
                type: 'lofs',
                options: [
                    'ro',
                    'nodevices'
                ]
            } ]
        },
        metadata: {
            SERVICE_NAME: 'assets',
            SERVICE_DOMAIN: 'TO_FILL_IN',
            resolvers: 'TO_FILL_IN',
            'registrar-config': registrarCfg,
            ufds_ldap_root_dn: 'TO_FILL_IN',
            ufds_ldap_root_pw: 'TO_FILL_IN',
            ufds_admin_ips: 'TO_FILL_IN',
            'user-script': 'TO_FILL_IN'
        }
    };

    var context = {
        svcData: serviceData
    };

    vasync.pipeline({arg: context, funcs: [
        function getSvc(ctx, next) {
            arg.sdcadm.sapi.listServices({
                name: 'assets',
                application_uuid: app.uuid
            }, function getSvcCb(svcErr, svcs) {
                if (svcErr) {
                    next(svcErr);
                    return;
                } else if (svcs.length) {
                    ctx.service = svcs[0];
                }
                next();
            });
        },

        /* @field ctx.pkg */
        function getPkg(ctx, next) {
            if (ctx.service) {
                next();
                return;
            }

            arg.sdcadm.papi.list({
                name: ctx.svcData.params.package_name,
                active: true
            }, {}, function listPkgCb(err, pkgs) {
                if (err) {
                    next(err);
                    return;
                } else if (pkgs.length !== 1) {
                    next(new errors.InternalError({
                        message: util.format(
                            '%d "%s" packages found', pkgs.length,
                            ctx.svcData.params.package_name)
                    }));
                    return;
                }
                ctx.pkg = pkgs[0];
                next();
            });
        },

        function getLatestImage(ctx, next) {
            if (ctx.service) {
                next();
                return;
            }

            arg.sdcadm.updates.listImages({
                name: 'assets'
            }, function listImgsCb(err, images) {
                if (err) {
                    next(err);
                } else if (images && images.length) {
                    ctx.img = images[images.length - 1];
                    next();
                } else {
                    next(new errors.UpdateError('no "assets" image found'));
                }
            });
        },

        function haveImageAlready(ctx, next) {
            if (ctx.service) {
                next();
                return;
            }

            arg.sdcadm.imgapi.listImages({
                name: 'assets'
            }, function listLocalImgsCb(err, images) {
                if (err) {
                    next(err);
                    return;
                } else if (images && images.length) {
                    ctx.img = images[images.length - 1];
                } else {
                    ctx.imgsToDownload.push(ctx.img);
                }
                next();
            });
        },

        /* @field ctx.userScript */
        shared.getUserScript,

        function createSvc(ctx, next) {
            if (ctx.service) {
                next();
                return;
            }
            // We want to skip couple next functions if we're not adding
            // service here:
            ctx.checkInstances = true;

            const meta = app.metadata;
            var domain = meta.datacenter_name + '.' +
                    meta.dns_domain;
            var svcDomain = ctx.svcData.name + '.' + domain;

            arg.progress('Creating "assets" service');
            ctx.svcData.params.image_uuid = ctx.img.uuid;
            ctx.svcData.metadata['user-script'] = ctx.userScript;
            ctx.svcData.metadata.SERVICE_DOMAIN = svcDomain;
            ctx.svcData.params.billing_id = ctx.pkg.uuid;
            ctx.svcData.metadata.resolvers = meta.binder_admin_ips;
            ctx.svcData.metadata.ufds_ldap_root_dn = meta.ufds_ldap_root_dn;
            ctx.svcData.metadata.ufds_ldap_root_pw = meta.ufds_ldap_root_pw;
            ctx.svcData.metadata.ufds_admin_ips = meta.ufds_admin_ips;
            ctx.svcData.metadata['registrar-config'].registration.domain =
                svcDomain;
            ctx.svcData.metadata['registrar-config'].registration.service
                .service.srvce = '_' + ctx.svcData.name;
            ctx.svcData.metadata['registrar-config'].zookeeper.servers =
                meta.ZK_SERVERS.map(function mapZkSrv(srv) {
                    return ({ host: srv.host, port: srv.port });
                });
            delete ctx.svcData.params.package_name;

            arg.sdcadm.sapi.createService('assets', app.uuid,
                    ctx.svcData, function createSvcCb(err, svc) {
                if (err) {
                    next(new errors.SDCClientError(err, 'sapi'));
                    return;
                }
                ctx.service = svc;
                arg.log.info({svc: svc}, 'created assets svc');
                next();
            });
        },
        function getSvcVmsFromVmapi(ctx, next) {
            if (!ctx.checkInstances) {
                next();
                return;
            }

            arg.sdcadm.vmapi.listVms({
                'tag.smartdc_role': 'assets',
                state: 'running',
                owner_uuid: arg.sdcadm.config.ufds_admin_uuid
            }, function listVmsCb(vmsErr, vms) {
                if (vmsErr) {
                    next(new errors.SDCClientError(vmsErr, 'vmapi'));
                    return;
                }
                ctx.vms = vms;
                next();
            });
        },
        function addSvcInstsToSapi(ctx, next) {
            if (!ctx.checkInstances) {
                next();
                return;
            }

            vasync.forEachParallel({
                inputs: ctx.vms,
                func: function createInst(vm, nextVm) {
                    arg.sdcadm.sapi.createInstance(ctx.service.uuid, {
                        uuid: vm.uuid,
                        params: {
                            alias: vm.alias
                        },
                        exists: true
                    }, function createInstCb(createErr) {
                        if (createErr) {
                            nextVm(new errors.SDCClientError(createErr,
                                'sapi'));
                            return;
                        }
                        nextVm();
                    });
                }
            }, next);
        }
    ]}, cb);
}
// --- exports

module.exports = {
    ensureAgentServices: ensureAgentServices,
    assertFullMode: assertFullMode,
    fixInstanceAlias: fixInstanceAlias,
    ensureAssetsService: ensureAssetsService
};

// vim: set softtabstop=4 shiftwidth=4:
