/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var assert = require('assert-plus');
var sprintf = require('extsprintf').sprintf;
var vasync = require('vasync');

var errors = require('../errors');


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

    var self = this;


    // SAPI values for sdc application:
    var sdc = self.sdcadm.sdcApp.metadata;
    // Name of SAPI services for VMs:
    var services;
    // Headnode sysinfo:
    var sysinfo;
    // External and admin networks:
    var admin;
    var external;
    // Shortcut:
    var cfg = self.sdcadm.config;

    // Errors:
    var errs = [];

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

    // PEDRO: Shall we really care about core zone Admin IP addresses here?:
    // (Ignoring for now)
    function getVmsIps(_, next) {
        var filters = {
            query: sprintf('(&(tags=*-smartdc_type=core-*)' +
                   '(|(state=running)(state=provisioning)(state=stopped))' +
                   '(owner_uuid=%s))', cfg.ufds_admin_uuid)
        };
        self.sdcadm.vmapi.listVms(filters, next);

    }

    self.sdcadm.sapi.listServices({
        application_uuid: sdc.uuid
    }, function listSvcsCb(err, res) {
        if (err) {
            cb(err);
            return;
        }
        if (!res.length) {
            cb('Cannot find SDC services in SAPI');
            return;
        }

        services = res.filter(function (s) {
            return (s.type === 'vm');
        }).map(function (s) {
            return (s.name);
        });

        vasync.pipeline({
            funcs: [
                getSysinfo,
                getNetworks,
                getDcFromUfds,
                getUfdsAdmin,
                getVmsIps
            ]
        }, function (err2, _res) {
            if (err2) {
                cb(err2);
                return;
            }

            // PEDRO: Note the exceptions listed below. I bet we could
            // remove most of these variables anyway, and left a single
            // value for *_pw.
            services.forEach(function checkSvcCfgVars(s) {
                if (s === 'cns' || s === 'portolan' || s === 'docker' ||
                    s === 'cmon' || s === 'volapi') {
                    return;
                }
                if (!sdc[s + '_root_pw'] && s !== 'manta' && s !== 'sapi') {
                    errs.push(sprintf('Missing %s_root_pw in SAPI', s));
                }

                if (!sdc[s + '_admin_ips'] && s !== 'cloudapi' &&
                    s !== 'manta' && s !== 'sdcsso') {
                    errs.push(sprintf('Missing %s_admin_ips in SAPI', s));
                }

                if (s !== 'manatee' && s !== 'binder' &&
                    s !== 'manta' && s !== 'cloudapi') {
                    if (!sdc[s + '_domain']) {
                        errs.push(sprintf('Missing %s_domain in SAPI', s));
                    }
                    if (!sdc[s.toUpperCase() + '_SERVICE']) {
                        errs.push(sprintf('Missing %s_SERVICE in SAPI',
                                s.toUpperCase()));
                    }
                }
            });
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
do_check_config.logToFile = false;

// --- exports

module.exports = {
    do_check_config: do_check_config
};
