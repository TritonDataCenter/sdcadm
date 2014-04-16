/*
 * Copyright (c) 2014 Joyent Inc. All rights reserved.
 */

var p = console.log;
var assert = require('assert-plus');
var exec = require('child_process').exec;
var format = require('util').format;
var fs = require('fs');
var path = require('path');
var sprintf = require('extsprintf').sprintf;
var vasync = require('vasync');
var verror = require('verror');

var errors = require('./errors'),
    InternalError = errors.InternalError;


//---- globals

var DEFAULTS_PATH = path.resolve(__dirname, '..', 'etc', 'defaults.json');
var CONFIG_PATH = '/var/sdcadm/sdcadm.conf';



//---- exports

/**
 * Load sdcadm config.
 *
 * Dev Notes: We load from /usbkey/config to avoid needing SAPI up to run
 * sdcadm (b/c eventually sdcadm might drive bootstrapping SAPI). This *does*
 * unfortunately perpetuate the split-brain between /usbkey/config and
 * metadata on the SAPI 'sdc' application. This also does limit `sdcadm`
 * usage to the headnode GZ (which is fine for now).
 */
function loadConfig(options, cb) {
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.func(cb, 'cb');
    var self = this;
    var log = options.log;

    var config = {};
    vasync.pipeline({funcs: [
        function loadDefaults(_, next) {
            log.trace({DEFAULTS_PATH: DEFAULTS_PATH}, 'load default config');
            fs.readFile(DEFAULTS_PATH, {encoding: 'utf8'},
                    function (err, data) {
                if (err) {
                    // TODO: InternalError
                    return next(err);
                }
                config = JSON.parse(data);  // presume no parse error
                next();
            });
        },
        function loadConfigPath(_, next) {
            fs.exists(CONFIG_PATH, function (exists) {
                if (!exists) {
                    return next();
                }
                log.trace({CONFIG_PATH: CONFIG_PATH}, 'load config file');
                fs.readFile(CONFIG_PATH, {encoding: 'utf8'},
                        function (err, data) {
                    if (err) {
                        // TODO: ConfigError
                        return next(err);
                    }
                    try {
                        config = objCopy(JSON.parse(data), config);
                    } catch (parseErr) {
                        // TODO: ConfigError
                        return next(parseErr);
                    }
                    next();
                });
            });
        },
        function loadSdcConfig(_, next) {
            var cmd = '/usr/bin/bash /lib/sdc/config.sh -json';
            log.trace({cmd: cmd}, 'load SDC config');
            exec(cmd, function (err, stdout, stderr) {
                if (err) {
                    return next(new InternalError({
                        message: 'could not load configuration from /usbkey/config',
                        cmd: cmd,
                        stderr: stderr,
                        cause: err
                    }));
                }
                try {
                    var sdcConfig = JSON.parse(stdout);
                } catch (parseErr) {
                    return next(new InternalError({
                        message: 'unexpected /usbkey/config content',
                        cause: parseErr
                    }));
                }
                config.dns_domain = sdcConfig.dns_domain;
                config.datacenter_name = sdcConfig.datacenter_name;
                config.ufds_admin_uuid = sdcConfig.ufds_admin_uuid;

                // Calculated config.
                var dns = config.datacenter_name + '.' + config.dns_domain;
                config.vmapi = {
                    url: sprintf('http://vmapi.%s', dns)
                };
                config.sapi = {
                    url: sprintf('http://sapi.%s', dns)
                };
                config.cnapi = {
                    url: sprintf('http://cnapi.%s', dns)
                };
                config.imgapi = {
                    url: sprintf('http://imgapi.%s', dns)
                };

                next();
            });
        }
    ]}, function done(err) {
        if (err) {
            return cb(err);
        }
        cb(null, config);
    });
}


function objCopy(obj, target) {
    if (!target) {
        target = {};
    }
    Object.keys(obj).forEach(function (k) {
        target[k] = obj[k];
    });
    return target;
}


function zeroPad(n, width) {
    var s = String(n);
    while (s.length < width) {
        s = '0' + s;
    }
    return s;
}



/**
 * Print a table of the given items.
 *
 * @params items {Array} of row objects.
 * @params options {Object}
 *      - `columns` {String} of comma-separated field names for columns
 *      - `skipHeader` {Boolean} Default false.
 *      - `sort` {String} of comma-separate fields on which to alphabetically
 *        sort the rows. Optional.
 *      - `validFields` {String} valid fields for `columns` and `sort`
 */
function tabulate(items, options) {
    assert.arrayOfObject(items, 'items');
    assert.object(options, 'options');
    assert.string(options.columns, 'options.columns');
    assert.optionalBool(options.skipHeader, 'options.skipHeader');
    assert.optionalString(options.sort, 'options.sort');
    assert.optionalString(options.validFields, 'options.validFields');

    if (items.length === 0) {
        return;
    }

    // Validate.
    var validFields = options.validFields && options.validFields.split(',');
    var columns = options.columns.split(',');
    var sort = options.sort ? options.sort.split(',') : [];
    if (validFields) {
        columns.forEach(function (c) {
            if (validFields.indexOf(c) === -1) {
                throw new TypeError(sprintf('invalid output field: "%s"', c));
            }
        });
    }
    sort.forEach(function (s) {
        if (s[0] === '-') s = s.slice(1);
        if (validFields && validFields.indexOf(s) === -1) {
            throw new TypeError(sprintf('invalid sort field: "%s"', s));
        }
    });

    // Function to lookup each column field in a row.
    var colFuncs = columns.map(function (lookup) {
        return new Function(
            'try { return (this["' + lookup + '"]); } catch (e) {}');
    });

    // Determine columns and widths.
    var widths = {};
    columns.forEach(function (c) { widths[c] = c.length; });
    items.forEach(function (item) {
        for (var j = 0; j < columns.length; j++) {
            var col = columns[j];
            var cell = colFuncs[j].call(item);
            if (cell === null || cell === undefined) {
                continue;
            }
            widths[col] = Math.max(
                widths[col], (cell ? String(cell).length : 0));
        }
    });

    var template = '';
    for (var i = 0; i < columns.length; i++) {
        if (i === columns.length - 1) {
            // Last column, don't have trailing whitespace.
            template += '%s';
        } else {
            template += '%-' + String(widths[columns[i]]) + 's  ';
        }
    }

    function cmp(a, b) {
        for (var j = 0; j < sort.length; j++) {
            var field = sort[j];
            var invert = false;
            if (field[0] === '-') {
                invert = true;
                field = field.slice(1);
            }
            assert.ok(field.length, 'zero-length sort field: ' + options.sort);
            var a_cmp = Number(a[field]);
            var b_cmp = Number(b[field]);
            if (isNaN(a_cmp) || isNaN(b_cmp)) {
                a_cmp = a[field] || '';
                b_cmp = b[field] || '';
            }
            if (a_cmp < b_cmp) {
                return (invert ? 1 : -1);
            } else if (a_cmp > b_cmp) {
                return (invert ? -1 : 1);
            }
        }
        return 0;
    }
    if (sort.length) {
        items.sort(cmp);
    }

    if (!options.skipHeader) {
        var header = columns.map(function (c) { return c.toUpperCase(); });
        header.unshift(template);
        console.log(sprintf.apply(null, header));
    }
    items.forEach(function (item) {
        var row = [];
        for (var j = 0; j < colFuncs.length; j++) {
            var cell = colFuncs[j].call(item);
            if (cell === null || cell === undefined) {
                row.push('-');
            } else {
                row.push(String(cell));
            }
        }
        row.unshift(template);
        console.log(sprintf.apply(null, row));
    });
}


function sortArrayOfObjects(items, fields) {
    function cmp(a, b) {
      for (var i = 0; i < fields.length; i++) {
        var field = fields[i];
        var invert = false;
        if (field[0] === '-') {
            invert = true;
            field = field.slice(1);
        }
        assert.ok(field.length, 'zero-length sort field: ' + fields);
        var a_cmp = Number(a[field]);
        var b_cmp = Number(b[field]);
        if (isNaN(a_cmp) || isNaN(b_cmp)) {
            a_cmp = a[field];
            b_cmp = b[field];
        }
        // Comparing < or > to `undefined` with any value always returns false.
        if (a_cmp === undefined && b_cmp === undefined) {
            // pass
        } else if (a_cmp === undefined) {
            return (invert ? 1 : -1);
        } else if (b_cmp === undefined) {
            return (invert ? -1 : 1);
        } else if (a_cmp < b_cmp) {
            return (invert ? 1 : -1);
        } else if (a_cmp > b_cmp) {
            return (invert ? -1 : 1);
        }
      }
      return 0;
    }
    items.sort(cmp);
}


//---- exports

module.exports = {
    loadConfig: loadConfig,
    objCopy: objCopy,
    zeroPad: zeroPad,
    tabulate: tabulate,
    sortArrayOfObjects: sortArrayOfObjects
};
// vim: set softtabstop=4 shiftwidth=4:
