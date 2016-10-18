/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * 'sdcadm post-setup fabrics'
 *
 * Command to setup portolan, the desired underlay-nics and fabrics and,
 * eventually, if docker is setup at this point, update metadata to use
 * fabrics.
 *
 * RFD:
 * - Shall we keep "--force" option to allow using the same command
 *   `sdcadm post-setup fabrics` to update fabric_cfg sapi metadata or
 *   should we create another command for that matter? (something like
 *   `sdcadm up(date) fabrics` or just `sdcadm fabrics`, taking a single
 *   argument `-c | --conf` and asking for explicit confirmation).
 * - Shall we keep the "--coal" option or just remove it and, in case
 *   we detect we're running on COAL and the user is not providing a
 *   config argument, ask her to confirm if want to use default coal cfg?.
 */

var assert = require('assert-plus');
var vasync = require('vasync');
var util = require('util');
var fmt = util.format;
var fs = require('fs');
var jsprim = require('jsprim');
var schemas = require('joyent-schemas');
var sprintf = require('extsprintf').sprintf;

var errors = require('../errors');
var common = require('../common');
var DownloadImages = require('../procedures/download-images').DownloadImages;
var shared = require('../procedures/shared');

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

//---- internal support stuff

function Fabrics() {}

Fabrics.prototype.name = 'fabrics';
Fabrics.prototype.help = (
    'Create portolan instance and setup fabrics.\n' +
    '\n' +
    'Initial setup of SmartDataCenter does not create a portolan instance.\n' +
    'This procedure will do that for you and setup underlay-nics and\n' +
    'fabrics and, if docker is setup, update docker config to use fabrics.\n'
);

Fabrics.prototype.execute = function execute(options, cb) {
    var self = this;
    assert.object(options, 'options');
    assert.object(options.sdcadm, 'options.sdcadm');
    assert.object(options.log, 'options.log');
    assert.string(options.conf, 'options.conf');
    assert.func(options.progress, 'options.progress');
    assert.bool(options.reconfigure, 'options.reconfigure');
    assert.func(cb, 'cb');

    self.options = options;

    self.log = options.log;
    self.sdcadm = options.sdcadm;
    self.progress = options.progress;


    /*
     * Pipeline stages:
     * 0. setup portolan if needed
     * 1. check schema, if not set, set schema
     * 2. check if set up already, if yes, error
     * 3. get configuration
     * 4. check config against local schema
     * 5. set that configuration
     * 6. check if docker has been setup and update it to use fabrics
     * 7. restart required services
     */

    vasync.pipeline({funcs: [
        function _getHeadnode(_, next) {
            self.getHeadnode(next);
        },
        function _setupPortolan(_, next) {
            self.setupPortolan(next);
        },
        function _setupNat(_, next) {
            self.setupNat(next);
        },
        function _initDiffSchema(_, next) {
            self.initDiffSchema(next);
        },
        function _initConfig(_, next) {
            self.initConfig(next);
        },
        function _checkSchema(_, next) {
            self.checkSchema(next);
        },
        function _checkNicTags(_, next) {
            self.checkNicTags(next);
        },
        function _checkAssignment(_, next) {
            self.checkAssignment(next);
        },
        function _checkNatPool(_, next) {
            self.checkNatPool(next);
        },
        function _updateSapi(_, next) {
            self.updateSapi(next);
        },
        function _checkDocker(_, next) {
            self.checkDocker(next);
        },
        function _updateFabricsSvcs(_, next) {
            self.updateFabricsSvcs(next);
        }
    ]}, function (err) {
        if (err) {
            return cb(err);
        }
        self.progress('Done!');
        return cb();
    });
};


Fabrics.prototype.getHeadnode = function getHeadnode(cb) {
    var self = this;
    self.sdcadm.cnapi.listServers({
        headnode: true
    }, function (err, servers) {
        if (err) {
            return cb(new errors.SDCClientError(err, 'cnapi'));
        }
        self.headnode = servers[0];
        return cb();
    });
};


Fabrics.prototype.setupPortolan = function setupPortolan(cb) {
    var self = this;

    var svcData = {
        name: 'portolan',
        params: {
            package_name: 'sdc_768',
            image_uuid: 'TO_FILL_IN',
            maintain_resolvers: true,
            networks: ['admin'],
            firewall_enabled: true,
            tags: {
                smartdc_role: 'portolan',
                smartdc_type: 'core'
            },
            customer_metadata: {}
            // TO_FILL_IN: Fill out package values using sdc_768 package.
        },
        metadata: {
            SERVICE_NAME: 'portolan',
            SERVICE_DOMAIN: 'TO_FILL_IN',
            'user-script': 'TO_FILL_IN'
        }
    };

    var app = self.sdcadm.sdc;
    var headnode = self.headnode;

    var img, haveImg, svc, svcExists, instExists;

    vasync.pipeline({arg: {}, funcs: [
        /* @field ctx.package */
        function getPackage(ctx, next) {
            var filter = {name: 'sdc_768', active: true};
            self.sdcadm.papi.list(filter, {}, function (err, pkgs) {
                if (err) {
                    return next(err);
                } else if (pkgs.length !== 1) {
                    return next(new errors.InternalError({
                        message: pkgs.length + ' "sdc_768" packages found'
                    }));
                }
                ctx.package = pkgs[0];
                next();
            });
        },

        function getPortolanSvc(_, next) {
            self.sdcadm.sapi.listServices({
                name: 'portolan',
                application_uuid: app.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    return next(new errors.SDCClientError(svcErr, 'sapi'));
                } else if (svcs.length) {
                    svc = svcs[0];
                    svcExists = true;
                } else {
                    svcExists = false;
                }
                next();
            });
        },

        function getPortolanInst(_, next) {
            if (!svcExists) {
                instExists = false;
                return next();
            }
            var filter = {
                service_uuid: svc.uuid,
                name: 'portolan'
            };
            self.sdcadm.sapi.listInstances(filter, function (err, insts) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                } else if (insts && insts.length) {
                    // Note this doesn't handle multiple insts.
                    instExists = true;
                } else {
                    instExists = false;
                }
                next();
            });
        },

        function getLatestImage(_, next) {
            var filter = {name: 'portolan'};
            self.sdcadm.updates.listImages(filter, function (err, images) {
                if (err) {
                    return next(err);
                } else if (images && images.length) {
                    img = images[images.length - 1]; //XXX presuming sorted
                    return next();
                } else {
                    return next(new errors.UpdateError(
                                'no "portolan" image found'));
                }
            });
        },

        function haveImageAlready(_, next) {
            self.sdcadm.imgapi.getImage(img.uuid, function (err, img_) {
                if (err && err.body && err.body.code === 'ResourceNotFound') {
                    haveImg = false;
                    next();
                } else if (err) {
                    next(new errors.SDCClientError(err, 'imgapi'));
                    next(err);
                } else {
                    haveImg = true;
                    next();
                }
            });
        },

        function importImage(_, next) {
            if (haveImg) {
                return next();
            }
            var proc = new DownloadImages({images: [img]});
            proc.execute({
                sdcadm: self.sdcadm,
                log: self.log,
                progress: self.progress
            }, next);
        },

        /* @field ctx.userScript */
        shared.getUserScript,

        function createPortolanSvc(ctx, next) {
            if (svcExists) {
                self.progress('Service "portolan" already exists');
                return next();
            }

            var domain = app.metadata.datacenter_name + '.' +
                    app.metadata.dns_domain;
            var svcDomain = svcData.name + '.' + domain;

            self.progress('Creating "portolan" service');
            svcData.params.image_uuid = img.uuid;
            svcData.metadata['user-script'] = ctx.userScript;
            svcData.metadata.SERVICE_DOMAIN = svcDomain;
            svcData.params.billing_id = ctx.package.uuid;
            delete svcData.params.package_name;

            self.sdcadm.sapi.createService('portolan', app.uuid, svcData,
                    function (err, svc_) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                svc = svc_;
                self.log.info({svc: svc}, 'created portolan svc');
                next();
            });
        },

        function createPortolanInst(_, next) {
            if (instExists) {
                self.progress('Instance "portolan0" already exists');
                return next();
            }
            self.progress('Creating "portolan" instance');
            var instOpts = {
                params: {
                    alias: 'portolan0',
                    server_uuid: headnode.uuid
                }
            };
            self.sdcadm.sapi.createInstance(svc.uuid, instOpts,
                    function (err, inst_) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                self.progress('Finished portolan setup');
                next();
            });
        }
    ]}, cb);

};


Fabrics.prototype.setupNat = function setupNat(cb) {
    var self = this;

    var natSvcData = {
        name: 'nat',
        params: {
            package_name: 'sdc_128',
            billing_id: 'TO_FILL_IN', // filled in from 'package_name'
            image_uuid: 'TO_FILL_IN',
            maintain_resolvers: true,
            /*
             * Intentionally no 'networks' field. It is explicitly set for
             * 'nat' zone creation in
             * sdc-vmapi.git:lib/workflows/fabrics-common.js.
             */
            firewall_enabled: false,
            tags: {
                smartdc_role: 'nat',
                smartdc_type: 'core'
            }
        },
        metadata: {
            // Allow these keys to actually live in the zone's metadata,
            // rather than being populated by config-agent (which doesn't
            // exist in NAT zones):
            pass_vmapi_metadata_keys: [ 'com.joyent:ipnat_subnet' ],
            SERVICE_NAME: 'nat',
            SERVICE_DOMAIN: 'TO_FILL_IN',
            'user-script': 'TO_FILL_IN'
        }
    };


    vasync.pipeline({arg: {
        app: self.sdcadm.sdc
    }, funcs: [

        /* @field ctx.natPkg */
        function getNatPkg(ctx, next) {
            var filter = {name: natSvcData.params.package_name, active: true};
            self.sdcadm.papi.list(filter, {}, function (err, pkgs) {
                if (err) {
                    return next(err);
                } else if (pkgs.length !== 1) {
                    return next(new errors.InternalError({
                        message: fmt('%d "%s" packages found', pkgs.length,
                            natSvcData.params.package_name)
                    }));
                }
                ctx.natPkg = pkgs[0];
                next();
            });
        },
        /* @field ctx.natImg */
        function getLatestNatImage(ctx, next) {
            var filter = {name: 'nat'};
            self.sdcadm.updates.listImages(filter, function (err, images) {
                if (err) {
                    next(err);
                } else if (images && images.length) {
                    // TODO presuming sorted
                    ctx.natImg = images[images.length - 1];
                    next();
                } else {
                    next(new errors.UpdateError('no "nat" image found'));
                }
            });
        },
        /* @field ctx.natSvc */
        function getNatSvc(ctx, next) {
            self.sdcadm.sapi.listServices({
                name: 'nat',
                application_uuid: ctx.app.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    return next(svcErr);
                } else if (svcs.length) {
                    ctx.natSvc = svcs[0];
                }
                next();
            });
        },
        /* @field ctx.haveImg */
        function haveNatImageAlready(ctx, next) {
            self.sdcadm.imgapi.getImage(ctx.natImg.uuid,
                    function (err, img_) {
                if (err && err.body && err.body.code === 'ResourceNotFound') {
                    ctx.haveImg = false;
                    return next();
                } else if (err) {
                    ctx.haveImg = false;
                    return next(err);
                }
                ctx.haveImg = true;
                next();
            });
        },

        function importImage(ctx, next) {
            if (ctx.haveImg) {
                return next();
            }
            var proc = new DownloadImages({images: [ctx.natImg]});
            proc.execute({
                sdcadm: self.sdcadm,
                log: self.log,
                progress: self.progress
            }, next);
        },

        /* @field ctx.userScript */
        shared.getUserScript,

        function createNatSvc(ctx, next) {
            if (ctx.natSvc) {
                return next();
            }

            var domain = ctx.app.metadata.datacenter_name + '.' +
                    ctx.app.metadata.dns_domain;
            var svcDomain = natSvcData.name + '.' + domain;

            self.progress('Creating "nat" service');
            natSvcData.params.image_uuid = ctx.natImg.uuid;
            natSvcData.metadata['user-script'] = ctx.userScript;
            natSvcData.metadata.SERVICE_DOMAIN = svcDomain;
            natSvcData.params.billing_id = ctx.natPkg.uuid;
            delete natSvcData.params.package_name;

            self.sdcadm.sapi.createService('nat', ctx.app.uuid,
                    natSvcData, function (err, svc) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                ctx.natSvc = svc;
                self.progress('Created nat service');
                self.log.info({svc: svc}, 'created nat svc');
                next();
            });
        }
    ]}, cb);
};


Fabrics.prototype.initDiffSchema = function initDiffSchema(cb) {
    var self = this;
    var schema = schemas.sdc.sdc_app;
    var fab, mdata;
    var app = self.sdcadm.sdc;

    if ('metadata_schemas' in app &&
        'properties' in app.metadata_schemas &&
        'fabric_cfg' in app.metadata_schemas.properties) {
        mdata = app.metadata_schemas;
        fab = mdata.properties.fabric_cfg;
        if (jsprim.deepEqual(fab, schema.properties.fabric_cfg)) {
            self.alreadySetup = true;
            return cb(null);
        }
    }

    self.sdcadm.sapi.updateApplication(app.uuid, {
        action: 'update',
        metadata_schema: schema
    }, function (err, sdcApp) {
        if (err) {
            return cb(new errors.SDCClientError(err, 'sapi'));
        }
        self.sdcadm.sdc = sdcApp;
        return cb(null);
    });
};


Fabrics.prototype.initConfig = function initConfig(cb) {
    var self = this;
    if (!self.options.conf) {
        return cb();
    }

    var conf = self.options.conf;

    fs.readFile(conf, { format: 'utf8' }, function (err, data) {
        if (err) {
            return cb(new errors.ValidationError(err,
                sprintf('failed to read %s: %s', conf, err.message)));
        }
        try {
            data = JSON.parse(data);
        } catch (e) {
            return cb(new errors.ValidationError(e,
                sprintf('%s in not a valid JSON file', conf)));
        }
        self.data = data;
        cb(null);
    });
};

Fabrics.prototype.checkSchema = function checkSchema(cb) {
    var ret;
    var schema = schemas.sdc.sdc_app;
    var self = this;

    ret = jsprim.validateJsonObject(schema.properties.fabric_cfg,
        self.data);

    if (ret !== null) {
        return cb(new errors.ValidationError(ret,
             sprintf('invalid fabric configuration: %s', ret)));
    }

    cb(null);
};

Fabrics.prototype.checkNicTags = function checkNicTags(cb) {
    var self = this;
    self.sdcadm.napi.getNicTag(self.data.sdc_underlay_tag,
        function (err, tag) {
        if (err) {
            if (napiUserError(err, 'name')) {
                return cb(new errors.ValidationError(err,
                    sprintf('failed to find nic tag: %s, it ' +
                        'either does not exist or is invalid',
                    self.data.sdc_underlay_tag)));
            } else {
                return cb(new errors.SDCClientError(err, 'napi'));
            }
        }
        return cb(null);
    });
};


/*
 * If the user has opted for automatic assignment, then we need to make sure
 * that the network pool they've given us is valid.  Which means that it has to
 * be a valid pool (or network) and its nic tag must be the underlay tag
 * specified.
 */
Fabrics.prototype.checkAssignment = function checkAssignment(cb) {
    var self = this;
    if (self.data.sdc_underlay_assignment === 'manual') {
        if ('sdc_underlay_pool' in self.data) {
            return cb(new errors.ValidationError('cannot specify ' +
                '"sdc_underlay_pool" when "sdc_underlay_assignment"' +
                'is set to "manual"'));
        }
        return cb(null);
    }

    self.sdcadm.napi.getNetworkPool(self.data.sdc_underlay_pool,
        function (err, pool) {
        if (err) {
            if (napiUserError(err, 'uuid')) {
                return cb(new errors.ValidationError(err,
                    sprintf('failed to find resource pool: %s, it ' +
                        'either does not exist or is invalid',
                    self.data.sdc_underlay_pool)));
            } else {
                return cb(new errors.SDCClientError(err, 'napi'));
            }
        }

        /* All networks on a pool should have the same tag */
        self.sdcadm.napi.getNetwork(pool.networks[0],
            function (neterr, net) {
            if (neterr) {
                return cb(new errors.SDCClientError(neterr, 'napi'));
            }
            if (net.nic_tag !== self.data.sdc_underly_tag) {
                return cb(new errors.ValidationError(sprintf('specified ' +
                    'network pool %s has nic tag %s, which does not ' +
                    'match fabric configuration "sdc_underlay_tag": %s',
                    self.data.sdc_underlay_pool,
                    net.nic_tag,
                    self.data.sdc_underlay_tag)));
            }
            return cb(null);
        });
    });
};


/*
 * Check that the external network pool for NAT zones exists.
 */
Fabrics.prototype.checkNatPool = function checkNatPool(cb) {
    var self = this;

    self.sdcadm.napi.getNetworkPool(self.data.sdc_nat_pool,
            function (err, pool) {
        if (err) {
            if (napiUserError(err, 'uuid')) {
                return cb(new errors.ValidationError(err,
                    sprintf('failed to find NAT network pool: %s, it ' +
                        'either does not exist or is invalid',
                    self.data.sdc_nat_pool)));
            } else {
                return cb(new errors.SDCClientError(err, 'napi'));
            }
        }

        return cb(null);
    });
};

Fabrics.prototype.updateSapi = function updateSapi(cb) {
    var self = this;

    if (self.sdcadm.sdc.metadata.fabric_cfg && !self.options.reconfigure) {
        self.progress('Fabric configuration already in SAPI');
        self.progress('Please, use \'--reconfigure\' if you want to override');
        return cb(null);
    }

    if (self.sdcadm.sdc.metadata.fabric_cfg &&
            jsprim.deepEqual(self.sdcadm.sdc.metadata.fabric_cfg, self.data)) {
        self.progress('Exactly the same fabric configuration already in SAPI');
        return cb(null);
    }
    self.configChanged = true;

    var word = (self.sdcadm.sdc.metadata.fabric_cfg) ? 'Updating' : 'Adding';
    self.progress('%s fabric configuration', word);
    /*
     * Note, we're updating the entire application here, but update today only
     * ever goes one layer deep. eg. update will always replace our key,
     * 'fabric_cfg', with one that's always what we give it. In this case, it
     * shouldn't merge anything. If that behavior changes, we're in trouble and
     * the docs don't exactly promise one behavior or another...
     */
    self.sdcadm.sapi.updateApplication(self.sdcadm.sdc.uuid, {
        action: 'update',
        metadata: { fabric_cfg: self.data }
    }, errors.sdcClientErrWrap(cb, 'sapi'));
};


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
Fabrics.prototype.updateFabricsSvcs = function updateFabricsSvcs(cb) {
    var self = this;
    if (!self.configChanged) {
        return cb(null);
    }
    var svcs = ['napi', 'vmapi', 'dhcpd'];

    self.progress('Restarting config of services using "fabric_cfg": %s',
    svcs.join(', '));

    if (self.dockerSetup) {
        svcs.push('docker');
    }
    vasync.forEachParallel({
        inputs: svcs,
        func: function updateSvc(svc, next) {
            common.spawnRun({
                argv: ['/opt/smartdc/bin/sdc-login', svc,
                    'cd /opt/smartdc/config-agent && ' +
                    './build/node/bin/node agent.js -s'],
                log: self.sdcadm.log
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

};

/**
 * Given it's possible to setup docker after fabrics, we'll keep the option
 * to also run the command with --reconfigure in order to make sure we write
 * the right metadata to docker svc
 */
Fabrics.prototype.checkDocker = function checkDocker(cb) {
    var self = this;
    self.sdcadm.getSvc({
        app: self.sdcadm.sdc.uuid,
        svc: 'docker',
        allowNone: true
    }, function (err, docker) {
        if (err) {
            return cb(err);
        }
        if (!docker) {
            return cb();
        }

        self.dockerSetup = true;
        if (!docker.metadata.USE_FABRICS) {
            self.sdcadm.sapi.updateService(docker.uuid, {
                action: 'update',
                metadata: { USE_FABRICS: true }
            }, function (er2, _docker) {
                if (er2) {
                    return cb(new errors.SDCClientError(er2, 'sapi'));
                }
                return cb();
            });
        } else {
            return cb();
        }
    });
};

//---- CLI

/*
 * Initialize fabrics for the DC
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

    if (opts.conf === undefined) {
        return cb(new errors.UsageError(
                    '"-c conf" is required'));
    }

    var proc = new Fabrics();
    proc.execute({
        sdcadm: this.sdcadm,
        log: this.log.child({postSetup: 'fabrics'}, true),
        progress: self.top.progress,
        conf: opts.conf,
        reconfigure: opts.reconfigure || false
    }, cb);
}

do_fabrics.help = (
    Fabrics.prototype.help +
    '\n' +
    'Usage:\n' +
    '    {{name}} fabrics [-c conf] [--reconfigure] [-h]\n' +
    '\n' +
    '{{options}}'
);

do_fabrics.options = [
    {
        names: [ 'help', 'h' ],
        type: 'bool',
        help: 'Display this help message'
    },
    {
        names: [ 'conf', 'c' ],
        type: 'string',
        help: 'Use the given configuration file (required)',
        helpArg: 'FILE'
    },
    {
        names: [ 'reconfigure', 'r' ],
        type: 'bool',
        help: 'Update fabrics configuration with the provided one'
    }
];


module.exports = {
    do_fabrics: do_fabrics
};
