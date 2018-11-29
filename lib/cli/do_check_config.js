/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var child_process = require('child_process'),
    execFile = child_process.execFile;

var assert = require('assert-plus');
var sprintf = require('extsprintf').sprintf;
var vasync = require('vasync');

var errors = require('../errors');

const SVCS_IN_CFG_FILE = [
    'binder',
    'manatee',
    'moray',
    'ufds',
    'workflow',
    'imgapi',
    'cnapi',
    'fwapi',
    'vmapi',
    'sdc',
    'papi',
    'ca',
    'adminui',
    'mahi',
    'amon',
    'amonredis',
    'assets',
    'dhcpd',
    'rabbitmq',
    'napi',
    'sapi'
];

/*
 * Try to load and return usbkey config from the system, or the appropriate
 * error message on failure
 */
function loadUsbConfig(cb) {
    execFile('/bin/bash', ['/lib/sdc/config.sh', '-json'],
        function loadUsbConfigCb(err, stdout, stderr) {
            if (err) {
                cb(new errors.InternalError({
                    cause: err,
                    message: 'Cannot load usbkey config: ' + stderr
                }));
                return;
            }

            var parseErr, config;

            try {
                config = JSON.parse(stdout);
            } catch (e) {
                parseErr = new errors.InternalError({
                    cause: e,
                    message: 'Cannot parse usbkey config'
                });
            }

            cb(parseErr, config);
    });
}

function CheckConfig(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.cli, 'opts.cli');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.sdcadm.sdcApp, 'opts.sdcadm.sdcApp');
    assert.func(opts.progress, 'opts.progress');
    assert.string(opts.uuid, 'opts.uuid');

    this.log = opts.log;
    this.sdcadm = opts.sdcadm;
    this.progress = opts.progress;
    this.uuid = opts.uuid;
    this.cli = opts.cli;
}


CheckConfig.prototype.name = 'check-config';

CheckConfig.prototype.execute = function cExecute(opts, args, cb) {
    assert.object(opts, 'opts');
    assert.object(args, 'args');
    assert.func(cb, 'cb');

    const self = this;
    // SAPI values for sdc application:
    const sdc = self.sdcadm.sdcApp.metadata;
    // Shortcut:
    const cfg = self.sdcadm.config;

    // Headnode sysinfo:
    let sysinfo;
    // External and admin networks:
    let admin;
    let external;
    // Errors:
    let errs = [];
    // Context object to pass to vasync pipeline functions:
    let context = {
        // Admin IPs for the different service instances:
        // (Using a map to avoid bothering with hasOwnProperty)
        adminIps: new Map()
    };


    function getSysinfo(_, next) {
        self.sdcadm.cnapi.listServers({
            headnode: true,
            extras: 'sysinfo'
        }, function listServersCb(err, res) {
            if (err) {
                next(err);
                return;
            }
            sysinfo = (res && res.length > 0 ? res[0].sysinfo : null);
            var sysinfoNics = sysinfo['Network Interfaces'];
            Object.keys(sysinfoNics).filter(function findAdminNic(k) {
                return (sysinfoNics[k]['NIC Names'][0] ===
                    'admin');
            }).map(function checkAdminNics(k) {
                if (sysinfoNics[k]['MAC Address'] !==
                    sdc.admin_nic) {
                    errs.push('SAPI sdc admin_nic did not match with GZ ' +
                        'Admin MAC Address');
                }
                if (sysinfoNics[k].ip4addr !== sdc.admin_ip) {
                    errs.push('SAPI sdc admin_ip did not match with GZ ' +
                        'Admin IPv4 Address');
                }
            });

            var sysinfoVnics = sysinfo['Virtual Network Interfaces'];
            Object.keys(sysinfoVnics).filter(
                function findExternalNic(k) {
                return (k === 'external0');
            }).map(function checkExternalVnics(k) {
                if (sysinfoVnics[k].ip4addr !==
                    sdc.external_ip) {
                    errs.push('SAPI sdc external_ip did not match with GZ ' +
                        'External IPv4 Address');
                }
            });

            next();
        });
    }


    function getNetworks(_, next) {
        self.sdcadm.napi.listNetworks({
            name: 'admin'
        }, function listAdminNetworksCb(err, res) {
            if (err) {
                next(err);
                return;
            }
            admin = (res && res.length > 0 ? res[0] : null);
            if (admin.subnet.split('/')[0] !== sdc.admin_network) {
                errs.push('SAPI sdc admin_network did not match with value ' +
                    'defined in NAPI');
            }
            if (admin.netmask !== sdc.admin_netmask) {
                errs.push('SAPI sdc admin_netmask did not match with value ' +
                    'defined in NAPI');
            }
            // PEDRO: Note we should stop assuming external network will always
            // exist and, therefore, shouldn't return error on the next NAPI
            // call:
            self.sdcadm.napi.listNetworks({
                name: 'external'
            }, function listExternalNetworksCb(err2, res2) {
                if (err2) {
                    next(err2);
                    return;
                }
                external = (res2 && res2.length > 0 ? res2[0] : null);
                if (external.subnet &&
                    external.subnet.split('/')[0] !== sdc.external_network) {
                    errs.push('SAPI sdc external_network did not match with ' +
                        'value defined in NAPI');
                }
                if (external.netmask !== sdc.external_netmask) {
                    errs.push('SAPI sdc external_netmask did not match with ' +
                        'value defined in NAPI');
                }
                if (external.gateway !== sdc.external_gateway) {
                    errs.push('SAPI sdc external_gateway did not match with ' +
                        'value defined in NAPI');
                }
                if (external.provision_start_ip !==
                    sdc.external_provisionable_start) {
                    errs.push('SAPI sdc external_provisionable_start did not ' +
                        'match with value defined in NAPI');
                }
                if (external.provision_end_ip !==
                        sdc.external_provisionable_end) {
                    errs.push('SAPI sdc external_provisionable_end did not ' +
                        'match with value defined in NAPI');
                }
                next();
            });
        });
    }

    function getDcFromUfds(_, next) {
        self.sdcadm.ufds.search('o=smartdc', {
            scope: 'sub',
            filter: sprintf('(&(objectclass=datacenter)(datacenter=%s))',
                cfg.datacenter_name)
        }, function searchCb(err, res) {
            if (err) {
                next(err);
                return;
            }
            if (!res) {
                errs.push('No DC information found in UFDS');
                next();
                return;
            }
            res.forEach(function (r) {
                if (r.region !== sdc.region_name) {
                    errs.push(sprintf(
                        'region did not match with region_name for entry ' +
                        'with DN: %s', r.dn));
                }
                if (r.datacenter !== sdc.datacenter_name) {
                    errs.push(sprintf(
                        'data center did not match with datacenter_name for ' +
                        'entry with DN: %s', r.dn));
                }
                // company_name and location are not required for anything to
                // work properly, therefore, skipping them here
            });
            next();
        });
    }

    function getUfdsAdmin(_, next) {
        self.sdcadm.ufds.search('o=smartdc', {
            scope: 'sub',
            filter: sprintf('(&(objectclass=sdcperson)(uuid=%s))',
                cfg.ufds_admin_uuid)
        }, function searchCb(err, res) {
            if (err) {
                next(err);
                return;
            }

            var ufdsAdmin = (res && res.length > 0 ? res[0] : null);

            if (!ufdsAdmin) {
                errs.push('Cannot find UFDS admin user');
            }

            if (ufdsAdmin.login !== sdc.ufds_admin_login) {
                errs.push('UFDS admin login did not match SAPI ' +
                    'ufds_admin_login');
            }

            if (ufdsAdmin.email !== sdc.ufds_admin_email) {
                errs.push('UFDS admin email did not match SAPI ' +
                    'ufds_admin_email');
            }

            self.sdcadm.ufds.search(sprintf('uuid=%s, ou=users, o=smartdc',
                        cfg.ufds_admin_uuid), {
                scope: 'sub',
                filter: '(objectclass=sdckey)'
            }, function searchKeyCb(err2, res2) {
                if (err2) {
                    next(err2);
                    return;
                }

                if (!res2.length) {
                    errs.push('Cannot find UFDS admin key');
                    next();
                    return;
                }

                var sdcKey = res2.filter(function (k) {
                    return (k.fingerprint === sdc.ufds_admin_key_fingerprint);
                })[0];

                if (!sdcKey) {
                    errs.push('Cannot find UFDS admin key');
                    next();
                    return;
                }

                if (sdcKey.openssh !== sdc.ufds_admin_key_openssh.trim()) {
                    errs.push('UFDS Admin key did not match with SAPI ' +
                            'ufds_admin_key_openssh');
                }
                next();
            });
        });
    }


    function getSapiSvcs(ctx, next) {
        self.sdcadm.getServices({
            type: 'vm'
        }, function getSvcsCb(svcsErr, svcs) {
            if (svcsErr) {
                next(svcsErr);
                return;
            }
            ctx.services = svcs;
            next();
        });
    }

    function getCoreVmInsts(ctx, next) {
        self.sdcadm.listInsts({
            types: ['vm']
        }, function listInstCb(listErr, insts) {
            if (listErr) {
                next(listErr);
                return;
            }
            ctx.insts = insts;
            next();
        });
    }

    function adminIpsBySvc(ctx, next) {
        for (let i = 0; i < ctx.services.length; i += 1) {
            const svcInsts = ctx.insts.filter(function findSvcInst(inst) {
                return (inst.service === ctx.services[i].name);
            });

            ctx.adminIps.set(ctx.services[i].name,
                svcInsts.map(function inst2ip(inst) {
                    return inst.ip;
                }));
        }
        next();
    }


    // Check '$SERVICE_admin_ips' against our admin_ips
    // Check '$SERVICE_client_url' when existing points to the admin IP
    // of an existing service admin ip
    // Perform these checks for both, usbkey config file and sapi's sdc app

    vasync.pipeline({
        funcs: [
            getSysinfo,
            getNetworks,
            getDcFromUfds,
            getUfdsAdmin,
            getSapiSvcs,
            getCoreVmInsts,
            adminIpsBySvc,
            function loadConfigFromFile(ctx, next) {
                loadUsbConfig(function loadCfgErr(cfgErr, usbCfg) {
                    if (cfgErr) {
                        next(cfgErr);
                        return;
                    }
                    ctx.usbCfg = usbCfg;
                    next();
                });
            }
        ],
        arg: context
    }, function pipelineCb(err2, _res) {
        if (err2) {
            cb(err2);
            return;
        }



        SVCS_IN_CFG_FILE.forEach(function checkSvcCfgVars(s) {
            if (!sdc[s + '_admin_ips']) {
                errs.push(sprintf('Missing %s_admin_ips in SAPI', s));
            }

            if (s !== 'manatee' && s !== 'binder' && s !== 'assets') {
                if (!sdc[s + '_domain']) {
                    errs.push(sprintf('Missing %s_domain in SAPI', s));
                }
                if (!sdc[s.toUpperCase() + '_SERVICE']) {
                    errs.push(sprintf('Missing %s_SERVICE in SAPI',
                            s.toUpperCase()));
                }
            }
        });

        for (let [svc, ips] of context.adminIps) {
            const ipsToString = ips.join(',');
            const keyName = svc + '_admin_ips';
            if (sdc[keyName] && sdc[keyName] !== ipsToString) {
                errs.push(sprintf('Value for %s in SAPI does not ' +
                    'match real instance(s) Admin Ips', svc));
            }

            if (context.usbCfg[keyName] &&
                context.usbCfg[keyName] !== ipsToString) {
                errs.push(sprintf('Value for %s in USB Config file does not ' +
                    'match real instance(s) Admin Ips', svc));
            }
        }

        // Check that ufds_remote_ip is present if this is not master:
        if (!sdc.ufds_is_master || sdc.ufds_is_master === 'false') {
            if (!sdc.ufds_remote_ip) {
                errs.push('Missing SAPI variable "ufds_remote_ip"');
            }
        }

        self.sdcadm.ufds.close(function (_err3) {
            cb(null, errs);
        });

    });
};

/*
 * The 'sdcadm check-config' CLI subcommand.
 */

function do_check_config(subcmd, opts, args, callback) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length > 0) {
        callback(new errors.UsageError('too many args: ' + args));
        return;
    }

    var self = this;

    self.sdcadm.ensureSdcApp({}, function (sdcadmErr) {
        if (sdcadmErr) {
            callback(sdcadmErr);
            return;
        }
        var proc = new CheckConfig({
            sdcadm: self.sdcadm,
            log: self.log,
            uuid: self.uuid,
            progress: self.progress,
            cli: self
        });
        opts.experimental = false;
        proc.execute(opts, args, function execCb(err, errs) {
            if (err) {
                callback(err);
            } else {
                if (errs && errs.length) {
                    errs.forEach(function (er) {
                        console.error(er);
                    });
                    callback();
                } else {
                    console.info('All good!');
                    callback();
                }
            }
        });
    });
}
do_check_config.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];
do_check_config.help = (
    'Check sdc config in SAPI versus system reality.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} check-config [<options>]\n' +
    '\n' +
    '{{options}}'
);


// --- exports

module.exports = {
    do_check_config: do_check_config
};
