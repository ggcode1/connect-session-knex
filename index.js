/* eslint-disable global-require */
/* eslint-disable no-prototype-builtins */
/* eslint-disable no-param-reassign */
/* eslint-disable no-nested-ternary */

const Bluebird = require('bluebird');

const { resolve } = Bluebird;
const util = require('util');

const oneDay = 86400000;


/*
   * Returns true if the specified knex instance is using sqlite3.
   * @return {bool}
   * @api private
   */
function isSqlite3(knex) {
  return knex.client.dialect === 'sqlite3';
}

/*
   * Returns true if the specified knex instance is using mysql.
   * @return {bool}
   * @api private
   */
function isMySQL(knex) {
  return ['mysql', 'mariasql', 'mariadb'].indexOf(knex.client.dialect) > -1;
}

/*
   * Returns true if the specified knex instance is using mssql.
   * @return {bool}
   * @api private
   */
function isMSSQL(knex) {
  return ['mssql'].indexOf(knex.client.dialect) > -1;
}

/*
   * Returns true if the specified knex instance is using postgresql.
   * @return {bool}
   * @api private
   */
function isPostgres(knex) {
  return ['postgresql'].indexOf(knex.client.dialect) > -1;
}

/*
   * Returns true if the specified knex instance is using oracle.
   * @return {bool}
   * @api private
   */
function isOracle(knex) {
  return ['oracle', 'oracledb'].indexOf(knex.client.dialect) > -1;
}

/*
   * Return dialect-aware type name for timestamp
   * @return {String} type name for timestamp
   * @api private
   */
function timestampTypeName(knex) {
  return isMySQL(knex) || isMSSQL(knex)
    ? 'DATETIME'
    : isPostgres(knex)
      ? 'timestamp with time zone'
      : 'timestamp';
}


/*
   * Return datastore appropriate string of the current time
   * @api private
   * @return {String | date}
   */
function dateAsISO(knex, aDate) {
  let date;
  if (aDate != null) {
    date = new Date(aDate);
  } else {
    date = new Date();
  }
  if (isOracle(knex)) {
    return date;
  }
  return isMySQL(knex) || isMSSQL(knex)
    ? date
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ')
    : date.toISOString();
}

/*
   * Return condition for filtering by expiration
   * @return {String} expired sql condition string
   * @api private
   */
function expiredCondition(knex) {
  let condition = `CAST(? as ${timestampTypeName(knex)}) <= expired`;
  if (isSqlite3(knex)) {
    // sqlite3 date condition is a special case.
    condition = 'datetime(?) <= datetime(expired)';
  } else if (isOracle(knex)) {
    condition = `CAST(? as ${timestampTypeName(knex)}) <= "expired"`;
  }
  return condition;
}

/*
   * Returns PostgreSQL fast upsert query.
   * @return {string}
   * @api private
   */
function getPostgresFastQuery(tablename, sidfieldname) {
  return (
    `with new_values (${
      sidfieldname
    }, expired, sess) as (`
      + '  values (?, ?::timestamp with time zone, ?::json)'
      + '), '
      + 'upsert as '
      + '( '
      + `  update ${
        tablename
      } cs set `
      + `    ${
        sidfieldname
      } = nv.${
        sidfieldname
      }, `
      + '    expired = nv.expired, '
      + '    sess = nv.sess '
      + '  from new_values nv '
      + `  where cs.${
        sidfieldname
      } = nv.${
        sidfieldname
      } `
      + '  returning cs.* '
      + ')'
      + `insert into ${
        tablename
      } (${
        sidfieldname
      }, expired, sess) `
      + `select ${
        sidfieldname
      }, expired, sess `
      + 'from new_values '
      + `where not exists (select 1 from upsert up where up.${
        sidfieldname
      } = new_values.${
        sidfieldname
      })`
  );
}

/*
   * Returns SQLite fast upsert query.
   * @return {string}
   * @api private
   */
function getSqliteFastQuery(tablename, sidfieldname) {
  return (
    `insert or replace into ${
      tablename
    } (${
      sidfieldname
    }, expired, sess) values (?, ?, ?);`
  );
}

/*
   * Returns MySQL fast upsert query.
   * @return {string}
   * @api private
   */
function getMysqlFastQuery(tablename, sidfieldname) {
  return (
    `insert into ${
      tablename
    } (${
      sidfieldname
    }, expired, sess) values (?, ?, ?) on duplicate key update expired=values(expired), sess=values(sess);`
  );
}

/*
   * Returns MSSQL fast upsert query.
   * @return {string}
   * @api private
   */
function getMssqlFastQuery(tablename, sidfieldname) {
  return (
    `merge ${
      tablename
    } as T `
      + `using (values (?, ?, ?)) as S (${
        sidfieldname
      }, expired, sess) `
      + `on (T.${
        sidfieldname
      } = S.${
        sidfieldname
      }) `
      + 'when matched then '
      + 'update set expired = S.expired, sess = S.sess '
      + 'when not matched by target then '
      + `insert (${
        sidfieldname
      }, expired, sess) values (S.${
        sidfieldname
      }, S.expired, S.sess) `
      + 'output inserted.*;'
  );
}


/*
   * Remove expired sessions from database.
   * @param {Object} store
   * @param {number} interval
   * @api private
   */
function dbCleanup(store, interval, KnexStoreClass) {
  return store.ready
    .then(() => {
      let condition = `expired < CAST(? as ${timestampTypeName(store.knex)})`;
      if (isSqlite3(store.knex)) {
        // sqlite3 date condition is a special case.
        condition = 'datetime(expired) < datetime(?)';
      } else if (isOracle(store.knex)) {
        condition = `"expired" < CAST(? as ${timestampTypeName(store.knex)})`;
      }
      return store
        .knex(store.tablename)
        .del()
        .whereRaw(condition, dateAsISO(store.knex));
    })
    .finally(() => {
      KnexStoreClass.nextDbCleanup = setTimeout(
        dbCleanup,
        interval,
        store,
        interval,
      ).unref();
    });
}

module.exports = (connect) => {
  /**
   * Connect's Store.
   */
  const Store = connect.session ? connect.session.Store : connect.Store;
  /*
   * Initialize KnexStore with the given options.
   *
   * @param {Object} options
   * @api public
   */
  function KnexStore(options) {
    const self = this;

    options = options || {};
    Store.call(self, options);

    if (!options.clearInterval) {
      // Time to run clear expired function.
      options.clearInterval = 60000;
    }

    self.createtable = options.hasOwnProperty('createtable')
      ? options.createtable
      : true;
    self.tablename = options.tablename || 'sessions';
    self.sidfieldname = options.sidfieldname || 'sid';
    self.knex = options.knex
        || require('knex')({
          client: 'sqlite3',
          // debug: true,
          connection: {
            filename: 'connect-session-knex.sqlite',
          },
        });

    self.ready = self.knex.schema
      .hasTable(self.tablename)
      .then((exists) => {
        if (!exists && self.createtable) {
          return self.knex.schema.createTable(self.tablename, (table) => {
            table.string(self.sidfieldname).primary();
            if (isMSSQL(self.knex)) {
              table.text('sess').notNullable();
            } else {
              table.json('sess').notNullable();
            }
            if (isMySQL(self.knex) || isMSSQL(self.knex)) {
              table
                .dateTime('expired')
                .notNullable()
                .index();
            } else {
              table
                .timestamp('expired')
                .notNullable()
                .index();
            }
          });
        }
        return exists;
      })
      .then((exists) => {
        if (exists) {
          dbCleanup(self, options.clearInterval, KnexStore);
        }
        return null;
      });
  }

  // KnexStore.prototype.__proto__ = Store.prototype;
  util.inherits(KnexStore, Store);

  /*
     * Attempt to fetch session by the given sid.
     *
     * @param {String} sid
     * @param {Function} fn
     * @api public
     */
  KnexStore.prototype.get = (sid, fn) => {
    const self = this;
    return self.ready.then(() => {
      const condition = expiredCondition(self.knex);
      return resolve(self.knex
        .select('sess')
        .from(self.tablename)
        .where(self.sidfieldname, '=', sid)
        .andWhereRaw(condition, dateAsISO(self.knex))
        .then((response) => {
          let ret;
          if (response[0]) {
            ret = response[0].sess;
            if (typeof ret === 'string') {
              ret = JSON.parse(ret);
            }
          }
          return ret;
        }))
        .asCallback(fn);
    });
  };

  /*
     * Commit the given `sess` object associated with the given `sid`.
     *
     * @param {String} sid
     * @param {Session} sess
     * @param {Function} fn
     * @api public
     */
  KnexStore.prototype.set = (sid, sess, fn) => {
    const self = this;
    const { maxAge } = sess.cookie;
    const now = new Date().getTime();
    const expired = maxAge ? now + maxAge : now + oneDay;
    sess = JSON.stringify(sess);

    const dbDate = dateAsISO(self.knex, expired);

    if (isSqlite3(self.knex)) {
      // sqlite optimized query
      return self.ready.then(() => resolve(self.knex
        .raw(getSqliteFastQuery(self.tablename, self.sidfieldname), [
          sid,
          dbDate,
          sess,
        ])
        .then(() => [1]))
        .asCallback(fn));
    } if (
      isPostgres(self.knex)
        && parseFloat(self.knex.client.version) >= 9.2
    ) {
      // postgresql optimized query
      return self.ready.then(() => resolve(self.knex
        .raw(getPostgresFastQuery(self.tablename, self.sidfieldname), [
          sid,
          dbDate,
          sess,
        ]))
        .asCallback(fn));
    } if (isMySQL(self.knex)) {
      // mysql/mariaDB optimized query
      return self.ready.then(() => resolve(self.knex
        .raw(getMysqlFastQuery(self.tablename, self.sidfieldname), [
          sid,
          dbDate,
          sess,
        ]))
        .asCallback(fn));
    } if (isMSSQL(self.knex)) {
      // mssql optimized query
      return self.ready.then(() => resolve(self.knex
        .raw(getMssqlFastQuery(self.tablename, self.sidfieldname), [
          sid,
          dbDate,
          sess,
        ]))
        .asCallback(fn));
    }
    return self.ready.then(() => resolve(self.knex
      .transaction((trx) => trx
        .select('*')
        .forUpdate()
        .from(self.tablename)
        .where(self.sidfieldname, '=', sid)
        .then((foundKeys) => {
          if (foundKeys.length === 0) {
            return trx.from(self.tablename).insert({
              [self.sidfieldname]: sid,
              expired: dbDate,
              sess,
            });
          }
          return trx(self.tablename)
            .where(self.sidfieldname, '=', sid)
            .update({
              expired: dbDate,
              sess,
            });
        })))
      .asCallback(fn));
  };

  /**
     * Touch the given session object associated with the given session ID.
     *
     * @param {String} sid
     * @param {Session} sess
     * @param {Function} fn
     * @public
     */
  KnexStore.prototype.touch = (sid, sess, fn) => {
    if (sess && sess.cookie && sess.cookie.expires) {
      const condition = expiredCondition(this.knex);

      return resolve(this.knex(this.tablename)
        .where(this.sidfieldname, '=', sid)
        .andWhereRaw(condition, dateAsISO(this.knex))
        .update({
          expired: dateAsISO(this.knex, sess.cookie.expires),
        }))
        .asCallback(fn);
    }

    fn();
    return undefined;
  };

  /*
     * Destroy the session associated with the given `sid`.
     *
     * @param {String} sid
     * @api public
     */
  KnexStore.prototype.destroy = (sid, fn) => {
    const self = this;
    return self.ready.then(() => resolve(self.knex
      .del()
      .from(self.tablename)
      .where(self.sidfieldname, '=', sid))
      .asCallback(fn));
  };

  /*
     * Fetch number of sessions.
     *
     * @param {Function} fn
     * @api public
     */
  KnexStore.prototype.length = (fn) => {
    const self = this;
    return self.ready.then(() => resolve(self.knex
      .count(`${self.sidfieldname} as count`)
      .from(self.tablename)
      .then((response) => response[0].count || 0))
      .asCallback(fn));
  };

  /*
     * Clear all sessions.
     *
     * @param {Function} fn
     * @api public
     */
  KnexStore.prototype.clear = (fn) => {
    const self = this;
    return self.ready.then(() => resolve(self.knex
      .del()
      .from(self.tablename))
      .asCallback(fn));
  };

  /* stop the dbCleanupTimeout */
  KnexStore.prototype.stopDbCleanup = () => {
    if (KnexStore.nextDbCleanup) {
      clearTimeout(KnexStore.nextDbCleanup);
      delete KnexStore.nextDbCleanup;
    }
  };

  return KnexStore;
};
