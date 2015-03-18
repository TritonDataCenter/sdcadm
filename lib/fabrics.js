/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Logic to deal with the set up and manipulation of fabrics and fabric related
 * options.
 */

var assert = require('assert-plus');
var common = require('./common');
var errors = require('./errors');
var fmt = require('util').format;
var fs = require('fs');
var jsprim = require('jsprim');
var schemas = require('joyent-schemas');
var sprintf = require('extsprintf').sprintf;
var vasync = require('vasync');



/*
 * Distinguish between ENOENT and other errors for user sanity.  The way our
 * APIs are designed, this can come back to us in two different flavors. If a
 * URI parameter doesn't match some parameter, then we're going to get a 422
 * with an InvalidParameters error code. If it was a valid URI scheme, but it
 * doesn't exist, then we get a 404. If we're in the InvalidParameters case, we
 * make sure that it matches the part of the URI parameter that we expect,
 * otherwise we consider it an error that the user is not responsible for, eg.
 * say NAPI was down, or there was a programmer error.
 *
 * A friendly reminder, the error object that the API returns is wrapped up
 * slightly. The original error object that you'd see from hitting the API
 * directly is actually inside err.body and instead of err.code you want
 * err.restCode.
 */
function napiUserError(err, field) {
    if (err.restCode !== 'InvalidParameters' &&
        err.restCode !== 'ResourceNotFound') {
        return false;
    }

    if (err.restCode === 'InvalidParameters' &&
        (err.body.errors.length > 1 ||
        err.body.errors[0].field !== field)) {
        return false;
    }

    return true;
}


function fabInitDiffSchema(opts, cb) {
    var schema = schemas.sdc.sdc_app;
    var fab, mdata;

    assert.object(opts.sapiApp);

    if ('metadata_schemas' in opts.sapiApp &&
        'properties' in opts.sapiApp.metadata_schemas &&
        'fabric_cfg' in opts.sapiApp.metadata_schemas.properties) {
        mdata = opts.sapiApp.metadata_schemas;
        fab = mdata.properties.fabric_cfg;
        if (jsprim.deepEqual(fab, schema.properties.fabric_cfg)) {
             return cb(null);
        }
    }

    opts.sdcadm.sapi.updateApplication(opts.sapiApp.uuid, {
        action: 'update',
        metadata_schema: schema
    }, function (err, app) {
        if (err) {
            return cb(new errors.SDCClientError(err, 'sapi'));
        }
        opts.sapiApp = app;
        return cb(null);
    });
}

/*
 * If SAPI metadata for fabric_cfg exists, require that the force flag bet set.
 */
function fabInitCheckForce(opts, cb) {

    assert.object(opts.sapiApp);

    if (!('metadata' in opts.sapiApp)) {
        return cb(null);
    }

    if (!('fabric_cfg' in opts.sapiApp.metadata)) {
        return cb(null);
    }

    if (opts.force) {
        return cb(null);
    }

    return cb(new errors.ValidationError('fabric configuration already ' +
        'exists and -f was not specified, aborting'));
}


function fabCoalInitConf(opts, cb) {
    opts.progress('Initialize fabrics for CoaL');

    var napi = opts.sdcadm.napi;
    vasync.pipeline({arg: {}, funcs: [
        function createNicTag(ctx, next) {
            napi.getNicTag('sdc_underlay', function (err, nicTag) {
                if (!err) {
                    next();
                } else if (err.restCode === 'ResourceNotFound') {
                    opts.progress('Creating "sdc_underlay" NIC tag');
                    napi.createNicTag('sdc_underlay', next);
                } else {
                    next(err);
                }
            });
        },
        function createNetwork(ctx, next) {
            napi.listNetworks({name: 'sdc_underlay'}, function (err, nets) {
                if (err) {
                    next(err);
                } else if (nets.length >= 1) {
                    next();
                } else {
                    opts.progress('Creating "sdc_underlay" network');
                    napi.createNetwork({
                        name: 'sdc_underlay',
                        subnet: '10.88.88.0/24',
                        provision_start_ip: '10.88.88.205',
                        provision_end_ip: '10.88.88.250',
                        nic_tag: 'sdc_underlay',
                        vlan_id: 0
                    }, next);
                }
            });
        },
        function getExternalNet(ctx, next) {
            napi.listNetworks({name: 'external'}, function (err, nets) {
                if (err) {
                    return next(err);
                }
                assert.equal(nets.length, 1, 'exactly one "external" network');
                ctx.externalNet = nets[0];
                next();
            });
        },
        function createNetworkPool(ctx, next) {
            napi.listNetworkPools({name: 'sdc_nat'}, function (err, pools) {
                if (err) {
                    next(err);
                } else if (pools.length >= 1) {
                    ctx.natPool = pools[0];
                    next();
                } else {
                    opts.progress('Creating "sdc_nat" network pool');
                    napi.createNetworkPool('sdc_nat', {
                        networks: [ctx.externalNet.uuid]
                    }, function (createErr, pool) {
                        if (createErr) {
                            return next(createErr);
                        }
                        ctx.natPool = pool;
                        next();
                    });
                }
            });
        },
        function setData(ctx, next) {
            opts.data = {
                default_underlay_mtu: 1500,
                default_overlay_mtu: 1400,
                sdc_nat_pool: ctx.natPool.uuid,
                sdc_underlay_assignment: 'manual',
                sdc_underlay_tag: 'sdc_underlay'
            };
            opts.progress('Using this CoaL fabric config: %j', opts.data);
            next();
        }
    ]}, errors.sdcClientErrWrap(cb, 'napi'));
}

/*
 * Read all configuration from a specified file.
 */
function fabInitConf(opts, cb) {
    if (opts.coal) {
        return cb();
    }

    fs.readFile(opts.conf, { format: 'utf8' }, function (err, data) {
        if (err) {
            return cb(new errors.ValidationError(err,
                sprintf('failed to read %s: %s', opts.conf, err.message)));
        }
        try {
            data = JSON.parse(data);
        } catch (e) {
            return cb(new errors.ValidationError(e,
                sprintf('%s in not a valid JSON file', opts.conf)));
        }
        opts.data = data;
        cb(null);
    });
}

/*
 * First validate the schema
 */
function fabInitCheckSchema(opts, cb) {
    var ret;
    var schema = schemas.sdc.sdc_app;

    assert.object(opts.data);
    ret = jsprim.validateJsonObject(schema.properties.fabric_cfg,
        opts.data);
    if (ret !== null) {
         return cb(new errors.ValidationError(ret,
             sprintf('invalid fabric configuration: %s', ret)));
    }

    cb(null);
}

function fabInitCheckTags(opts, cb) {
    assert.object(opts.data);
    opts.sdcadm.napi.getNicTag(opts.data.sdc_underlay_tag,
        function (err, tag) {
        if (err) {
            if (napiUserError(err, 'name')) {
                return cb(new errors.ValidationError(err,
                    sprintf('failed to find nic tag: %s, it ' +
                        'either does not exist or is invalid',
                    opts.data.sdc_underlay_tag)));
            } else {
                return cb(new errors.SDCClientError(err, 'napi'));
            }
        }
        return cb(null);
    });
}

/*
 * If the user has opted for automatic assignment, then we need to make sure
 * that the network pool they've given us is valid.  Which means that it has to
 * be a valid pool (or network) and its nic tag must be the underlay tag
 * specified.
 */
function fabInitCheckAssignment(opts, cb) {
    assert.object(opts.data);
    if (opts.data.sdc_underlay_assignment === 'manual') {
        if ('sdc_underlay_pool' in opts.data) {
            return cb(new errors.ValidationError('cannot specify ' +
                '"sdc_underlay_pool" when "sdc_underlay_assignment"' +
                'is set to "manual"'));
        }
        return cb(null);
    }

    opts.sdcadm.napi.getNetworkPool(opts.data.sdc_underlay_pool,
        function (err, pool) {
        if (err) {
            if (napiUserError(err, 'uuid')) {
                return cb(new errors.ValidationError(err,
                    sprintf('failed to find resource pool: %s, it ' +
                        'either does not exist or is invalid',
                    opts.data.sdc_underlay_pool)));
            } else {
                return cb(new errors.SDCClientError(err, 'napi'));
            }
        }

        /* All networks on a pool should have the same tag */
        opts.sdcadm.napi.getNetwork(pool.networks[0],
            function (neterr, net) {
            if (neterr) {
                return cb(new errors.SDCClientError(neterr, 'napi'));
            }
            if (net.nic_tag !== opts.data.sdc_underly_tag) {
                return cb(new errors.ValidationError(sprintf('specified ' +
                    'network pool %s has nic tag %s, which does not ' +
                    'match fabric configuration "sdc_underlay_tag": %s',
                    opts.data.sdc_underlay_pool,
                    net.nic_tag,
                    opts.data.sdc_underlay_tag)));
            }
            return cb(null);
        });
    });
}

/*
 * Check that the external network pool for NAT zones exists.
 */
function fabCheckNatPool(opts, cb) {
    assert.object(opts.data);

    opts.sdcadm.napi.getNetworkPool(opts.data.sdc_nat_pool,
            function (err, pool) {
        if (err) {
            if (napiUserError(err, 'uuid')) {
                return cb(new errors.ValidationError(err,
                    sprintf('failed to find NAT network pool: %s, it ' +
                        'either does not exist or is invalid',
                    opts.data.sdc_nat_pool)));
            } else {
                return cb(new errors.SDCClientError(err, 'napi'));
            }
        }

        return cb(null);
    });
}

function fabInitUpdate(opts, cb) {
    assert.object(opts.data);

    /*
     * Note, we're updating the entire application here, but update today only
     * ever goes one layer deep. eg. update will always replace our key,
     * 'fabric_cfg', with one that's always what we give it. In this case, it
     * shouldn't merge anything. If that behavior changes, we're in trouble and
     * the docs don't exactly promise one behavior or another...
     */
    opts.sdcadm.sapi.updateApplication(opts.sapiApp.uuid, {
        action: 'update',
        metadata: { fabric_cfg: opts.data }
    }, errors.sdcClientErrWrap(cb, 'sapi'));
}


/**
 * Ensure that services using 'fabric_cfg' update with the metdata update
 * in `fabInitUpdate`. This means that config-agent has updated their
 * config files and the services have restarted.
 *
 * Dev Note: Ideally we'd have a clean way to do this for services with
 * multiple and non-headnode instances. For example a standard admin endpoint.
 * But we don't have that. It would be useful to have a sdcadm function for
 * this. For now we'll manually hack via 'zlogin' to each HN instance.
 */
function fabEnsureSvcsUpdate(opts, cb) {
    var svcs = ['napi', 'vmapi', 'dhcpd'];
    opts.progress('Ensure services using "fabric_cfg" update:',
        svcs.join(', '));
    vasync.forEachParallel({
        inputs: svcs,
        func: function updateSvc(svc, next) {
            common.spawnRun({
                argv: ['/opt/smartdc/bin/sdc-login', svc,
                    'cd /opt/smartdc/config-agent && ' +
                    './build/node/bin/node agent.js -s'],
                log: opts.sdcadm.log
            }, next);
        }
    }, function (err) {
        if (err) {
            return cb(err);
        }

        /*
         * HACK: wait a few seconds for services to come back up. A better
         * answer would be sdcadm `checkSvc(svc)` support that could wait
         * for the service to be healthy, with a timeout.
         */
        setTimeout(cb, 3000);
    });
}


/*
 * Set the default fabric for the admin user ('--coal'-only)
 */
function fabCoalAdminDefaultFabric(opts, cb) {
    if (!opts.coal) {
        return cb();
    }

    var defFabric = require('./default-fabric');
    defFabric.addDefaultFabric({
        sdcadm: opts.sdcadm,
        progress: opts.progress,
        account: opts.sdcadm.config.ufds_admin_uuid // 'admin' account
    }, cb);
}


/*
 * Not implemented. This just adds a note for manual work for the user.
 * TODO: Implement this.
 */
function fabCoalCNSetup(opts, cb) {
    var setupLink = 'https://gist.github.com/rgulewich/d531482a33fe402616e6' +
        '#cn-setup-can-skip-if-you-dont-have-a-cn';
    opts.sdcadm.cnapi.listServers(function (err, servers) {
        if (err) {
            return cb(err);
        }
        servers.forEach(function (server) {
            if (server.headnode) {
                opts.headnodeUuid = server.uuid;
                return;
            }
            opts.manualTodos.push(fmt('Manually setup server %s (%s) per %s',
                server.uuid, server.hostname, setupLink));
        });
        cb();
    });
}

function fabCoalHNSetup(opts, cb) {
    opts.progress('Setting up CoaL HN fabric');
    var napi = opts.sdcadm.napi;
    vasync.pipeline({arg: {}, funcs: [
        function updateNic(ctx, next) {
            napi.updateNic('00:50:56:3d:a7:95',
                {nic_tags_provided: ['external', 'sdc_underlay']}, next);
        },
        function getSdcUnderlayNet(ctx, next) {
            napi.listNetworks({name: 'sdc_underlay'}, function (err, nets) {
                if (err) {
                    return next(err);
                }
                assert.equal(nets.length, 1,
                    'exactly one "sdc_underlay" network');
                ctx.sdcUnderlayNet = nets[0];
                next();
            });
        },
        function provisionNic(ctx, next) {
            napi.provisionNic(ctx.sdcUnderlayNet.uuid, {
                // XXX CR(rob): headnodeUuid here?
                belongs_to_uuid: opts.headnodeUuid,
                belongs_to_type: 'server',
                owner_uuid: opts.sdcadm.config.ufds_admin_uuid,
                underlay: true
            }, next);
        },
        function mountUsbkey(ctx, next) {
            common.spawnRun({
                argv: ['/usbkey/scripts/mount-usb.sh'],
                log: opts.sdcadm.log
            }, next);
        },
        function addBootTimeNetworkingFile(ctx, next) {
            opts.progress('Writing boot-time networking file to USB key');
            common.spawnRun({
                argv: ['/opt/smartdc/bin/sdc-login', 'dhcpd',
                    '/opt/smartdc/booter/bin/hn-netfile'],
                log: opts.sdcadm.log
            }, function (err, stdout) {
                if (err) {
                    return next(err);
                }
                fs.writeFile('/mnt/usbkey/boot/networking.json', stdout, next);
            });
        },
        function umountUsbkey(ctx, next) {
            common.spawnRun({
                argv: ['/usr/sbin/umount', '/mnt/usbkey'],
                log: opts.sdcadm.log
            }, next);
        },
        function todoReboot(ctx, next) {
            opts.manualTodos.push('Manually reboot headnode');
            next();
        }
    ]}, cb);
}


/*
 * Initialize fabrics for the DC.
 *
 * If run with '--coal' this will setup with hardcoded CoaL-appropriate
 * values.
 */
function do_fabrics(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help === true) {
        this.do_help('help', {}, [ subcmd ], cb);
        return;
    } else if (args.length !== 0) {
        return cb(new errors.UsageError('Extraneous arguments: ' +
            args.join(' ')));
    }
    if (opts.coal) {
        if (!this.sdcadm.config.coal) {
            return cb(new errors.UsageError(
                'cannot use "--coal" when not running in CoaL'));
        }
    } else if (opts.conf === undefined) {
        return cb(new errors.UsageError('"-c conf" or "--coal" is required'));
    }

    var pipeargs = {
        sdcadm: this.sdcadm,
        sapiApp: this.sdcadm.sdc,
        conf: opts.conf,
        force: opts.force,
        coal: opts.coal,
        progress: this.progress,
        manualTodos: []
    };

    /*
     * Pipeline stages:
     *
     * 1. check schema, if not set, set schema
     * 2. check if set up already, if yes, error
     * 3. get configuration
     * 4. check config against local schema
     * 5. set that configuration
     */
    vasync.pipeline({ arg: pipeargs, funcs: [
        fabInitDiffSchema,
        fabInitCheckForce,
        fabCoalInitConf,
        fabInitConf,
        fabInitCheckSchema,
        fabInitCheckTags,
        fabInitCheckAssignment,
        fabCheckNatPool,
        fabInitUpdate,
        fabEnsureSvcsUpdate,
        fabCoalAdminDefaultFabric,
        fabCoalCNSetup,
        fabCoalHNSetup
    ]}, function (err, results) {
        if (err) {
            return cb(err);
        }
        self.progress('Successfully initialized fabric sub-system');

        if (pipeargs.manualTodos.length) {
            self.progress('\n* * *\n' +
                'You must manually do the following to complete the ' +
                'set up:\n    ' +
                pipeargs.manualTodos.join('\n    '));
        }
        cb();
    });
}

do_fabrics.help = 'Initialize fabrics in the datacenter.\n' +
    '\n' +
    'Usage:\n' +
    '    {{name}} fabrics [-c conf] [-f] [-h]\n' +
    '    {{name}} fabrics [--coal]              # setup fabrics in COAL\n' +
    '\n' +
    '{{options}}';

do_fabrics.options = [
    {
        names: [ 'help', 'h' ],
        type: 'bool',
        help: 'Display this help message'
    },
    {
        names: [ 'conf', 'c' ],
        type: 'string',
        help: 'Use configuration information instead of prompting',
        helpArg: 'FILE'
    },
    {
        names: [ 'force', 'f' ],
        type: 'bool',
        help: 'force an update, even if fabric configuration already exists'
    },
    {
        names: [ 'coal' ],
        type: 'bool',
        help: 'Quickly setup fabrics for a COAL dev environment'
    }
];


module.exports = {
    do_fabrics: do_fabrics
};
