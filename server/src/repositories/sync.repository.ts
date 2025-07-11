import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, SelectQueryBuilder, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { columns } from 'src/database';
import { DB, SessionSyncCheckpoints } from 'src/db';
import { DummyValue, GenerateSql } from 'src/decorators';
import { SyncEntityType } from 'src/enum';
import { SyncAck } from 'src/types';

type AuditTables =
  | 'users_audit'
  | 'partners_audit'
  | 'assets_audit'
  | 'albums_audit'
  | 'album_users_audit'
  | 'album_assets_audit';
type UpsertTables = 'users' | 'partners' | 'assets' | 'exif' | 'albums' | 'albums_shared_users_users';

@Injectable()
export class SyncRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID] })
  getCheckpoints(sessionId: string) {
    return this.db
      .selectFrom('session_sync_checkpoints')
      .select(['type', 'ack'])
      .where('sessionId', '=', sessionId)
      .execute();
  }

  upsertCheckpoints(items: Insertable<SessionSyncCheckpoints>[]) {
    return this.db
      .insertInto('session_sync_checkpoints')
      .values(items)
      .onConflict((oc) =>
        oc.columns(['sessionId', 'type']).doUpdateSet((eb) => ({
          ack: eb.ref('excluded.ack'),
        })),
      )
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  deleteCheckpoints(sessionId: string, types?: SyncEntityType[]) {
    return this.db
      .deleteFrom('session_sync_checkpoints')
      .where('sessionId', '=', sessionId)
      .$if(!!types, (qb) => qb.where('type', 'in', types!))
      .execute();
  }

  @GenerateSql({ params: [], stream: true })
  getUserUpserts(ack?: SyncAck) {
    return this.db
      .selectFrom('users')
      .select(['id', 'name', 'email', 'deletedAt', 'updateId'])
      .$call((qb) => this.upsertTableFilters(qb, ack))
      .stream();
  }

  @GenerateSql({ params: [], stream: true })
  getUserDeletes(ack?: SyncAck) {
    return this.db
      .selectFrom('users_audit')
      .select(['id', 'userId'])
      .$call((qb) => this.auditTableFilters(qb, ack))
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID], stream: true })
  getPartnerUpserts(userId: string, ack?: SyncAck) {
    return this.db
      .selectFrom('partners')
      .select(['sharedById', 'sharedWithId', 'inTimeline', 'updateId'])
      .where((eb) => eb.or([eb('sharedById', '=', userId), eb('sharedWithId', '=', userId)]))
      .$call((qb) => this.upsertTableFilters(qb, ack))
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID], stream: true })
  getPartnerDeletes(userId: string, ack?: SyncAck) {
    return this.db
      .selectFrom('partners_audit')
      .select(['id', 'sharedById', 'sharedWithId'])
      .where((eb) => eb.or([eb('sharedById', '=', userId), eb('sharedWithId', '=', userId)]))
      .$call((qb) => this.auditTableFilters(qb, ack))
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID], stream: true })
  getAssetUpserts(userId: string, ack?: SyncAck) {
    return this.db
      .selectFrom('assets')
      .select(columns.syncAsset)
      .select('assets.updateId')
      .where('ownerId', '=', userId)
      .$call((qb) => this.upsertTableFilters(qb, ack))
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  getPartnerBackfill(userId: string, afterCreateId?: string) {
    return this.db
      .selectFrom('partners')
      .select(['sharedById', 'createId'])
      .where('sharedWithId', '=', userId)
      .$if(!!afterCreateId, (qb) => qb.where('createId', '>=', afterCreateId!))
      .where('createdAt', '<', sql.raw<Date>("now() - interval '1 millisecond'"))
      .orderBy('partners.createId', 'asc')
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, DummyValue.UUID], stream: true })
  getPartnerAssetsBackfill(partnerId: string, afterUpdateId: string | undefined, beforeUpdateId: string) {
    return this.db
      .selectFrom('assets')
      .select(columns.syncAsset)
      .select('assets.updateId')
      .where('ownerId', '=', partnerId)
      .where('updatedAt', '<', sql.raw<Date>("now() - interval '1 millisecond'"))
      .where('updateId', '<=', beforeUpdateId)
      .$if(!!afterUpdateId, (eb) => eb.where('updateId', '>=', afterUpdateId!))
      .orderBy('updateId', 'asc')
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID], stream: true })
  getPartnerAssetsUpserts(userId: string, ack?: SyncAck) {
    return this.db
      .selectFrom('assets')
      .select(columns.syncAsset)
      .select('assets.updateId')
      .where('ownerId', 'in', (eb) =>
        eb.selectFrom('partners').select(['sharedById']).where('sharedWithId', '=', userId),
      )
      .$call((qb) => this.upsertTableFilters(qb, ack))
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID], stream: true })
  getAssetDeletes(userId: string, ack?: SyncAck) {
    return this.db
      .selectFrom('assets_audit')
      .select(['id', 'assetId'])
      .where('ownerId', '=', userId)
      .$call((qb) => this.auditTableFilters(qb, ack))
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID], stream: true })
  getPartnerAssetDeletes(userId: string, ack?: SyncAck) {
    return this.db
      .selectFrom('assets_audit')
      .select(['id', 'assetId'])
      .where('ownerId', 'in', (eb) =>
        eb.selectFrom('partners').select(['sharedById']).where('sharedWithId', '=', userId),
      )
      .$call((qb) => this.auditTableFilters(qb, ack))
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID], stream: true })
  getAssetExifsUpserts(userId: string, ack?: SyncAck) {
    return this.db
      .selectFrom('exif')
      .select(columns.syncAssetExif)
      .select('exif.updateId')
      .where('assetId', 'in', (eb) => eb.selectFrom('assets').select('id').where('ownerId', '=', userId))
      .$call((qb) => this.upsertTableFilters(qb, ack))
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, DummyValue.UUID], stream: true })
  getPartnerAssetExifsBackfill(partnerId: string, afterUpdateId: string | undefined, beforeUpdateId: string) {
    return this.db
      .selectFrom('exif')
      .select(columns.syncAssetExif)
      .select('exif.updateId')
      .innerJoin('assets', 'assets.id', 'exif.assetId')
      .where('assets.ownerId', '=', partnerId)
      .where('exif.updatedAt', '<', sql.raw<Date>("now() - interval '1 millisecond'"))
      .where('exif.updateId', '<=', beforeUpdateId)
      .$if(!!afterUpdateId, (eb) => eb.where('exif.updateId', '>=', afterUpdateId!))
      .orderBy('exif.updateId', 'asc')
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID], stream: true })
  getPartnerAssetExifsUpserts(userId: string, ack?: SyncAck) {
    return this.db
      .selectFrom('exif')
      .select(columns.syncAssetExif)
      .select('exif.updateId')
      .where('assetId', 'in', (eb) =>
        eb
          .selectFrom('assets')
          .select('id')
          .where('ownerId', 'in', (eb) =>
            eb.selectFrom('partners').select(['sharedById']).where('sharedWithId', '=', userId),
          ),
      )
      .$call((qb) => this.upsertTableFilters(qb, ack))
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID], stream: true })
  getAlbumDeletes(userId: string, ack?: SyncAck) {
    return this.db
      .selectFrom('albums_audit')
      .select(['id', 'albumId'])
      .where('userId', '=', userId)
      .$call((qb) => this.auditTableFilters(qb, ack))
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID], stream: true })
  getAlbumUpserts(userId: string, ack?: SyncAck) {
    return this.db
      .selectFrom('albums')
      .distinctOn(['albums.id', 'albums.updateId'])
      .where('albums.updatedAt', '<', sql.raw<Date>("now() - interval '1 millisecond'"))
      .$if(!!ack, (qb) => qb.where('albums.updateId', '>', ack!.updateId))
      .orderBy('albums.updateId', 'asc')
      .leftJoin('albums_shared_users_users as album_users', 'albums.id', 'album_users.albumsId')
      .where((eb) => eb.or([eb('albums.ownerId', '=', userId), eb('album_users.usersId', '=', userId)]))
      .select([
        'albums.id',
        'albums.ownerId',
        'albums.albumName as name',
        'albums.description',
        'albums.createdAt',
        'albums.updatedAt',
        'albums.albumThumbnailAssetId as thumbnailAssetId',
        'albums.isActivityEnabled',
        'albums.order',
        'albums.updateId',
      ])
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID], stream: true })
  getAlbumToAssetDeletes(userId: string, ack?: SyncAck) {
    return this.db
      .selectFrom('album_assets_audit')
      .select(['id', 'assetId', 'albumId'])
      .where((eb) =>
        eb(
          'albumId',
          'in',
          eb
            .selectFrom('albums')
            .select(['id'])
            .where('ownerId', '=', userId)
            .union((eb) =>
              eb.parens(
                eb
                  .selectFrom('albums_shared_users_users as albumUsers')
                  .select(['albumUsers.albumsId as id'])
                  .where('albumUsers.usersId', '=', userId),
              ),
            ),
        ),
      )
      .$call((qb) => this.auditTableFilters(qb, ack))
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID], stream: true })
  getAlbumUserDeletes(userId: string, ack?: SyncAck) {
    return this.db
      .selectFrom('album_users_audit')
      .select(['id', 'userId', 'albumId'])
      .where((eb) =>
        eb(
          'albumId',
          'in',
          eb
            .selectFrom('albums')
            .select(['id'])
            .where('ownerId', '=', userId)
            .union((eb) =>
              eb.parens(
                eb
                  .selectFrom('albums_shared_users_users as albumUsers')
                  .select(['albumUsers.albumsId as id'])
                  .where('albumUsers.usersId', '=', userId),
              ),
            ),
        ),
      )
      .$call((qb) => this.auditTableFilters(qb, ack))
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  getAlbumBackfill(userId: string, afterCreateId?: string) {
    return this.db
      .selectFrom('albums_shared_users_users')
      .select(['albumsId as id', 'createId'])
      .where('usersId', '=', userId)
      .$if(!!afterCreateId, (qb) => qb.where('createId', '>=', afterCreateId!))
      .where('createdAt', '<', sql.raw<Date>("now() - interval '1 millisecond'"))
      .orderBy('createId', 'asc')
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, DummyValue.UUID, DummyValue.UUID], stream: true })
  getAlbumUsersBackfill(albumId: string, afterUpdateId: string | undefined, beforeUpdateId: string) {
    return this.db
      .selectFrom('albums_shared_users_users as album_users')
      .select(columns.syncAlbumUser)
      .select('album_users.updateId')
      .where('albumsId', '=', albumId)
      .where('updatedAt', '<', sql.raw<Date>("now() - interval '1 millisecond'"))
      .where('updateId', '<=', beforeUpdateId)
      .$if(!!afterUpdateId, (eb) => eb.where('updateId', '>=', afterUpdateId!))
      .orderBy('updateId', 'asc')
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID], stream: true })
  getAlbumUserUpserts(userId: string, ack?: SyncAck) {
    return this.db
      .selectFrom('albums_shared_users_users as album_users')
      .select(columns.syncAlbumUser)
      .select('album_users.updateId')
      .where('album_users.updatedAt', '<', sql.raw<Date>("now() - interval '1 millisecond'"))
      .$if(!!ack, (qb) => qb.where('album_users.updateId', '>', ack!.updateId))
      .orderBy('album_users.updateId', 'asc')
      .where((eb) =>
        eb(
          'album_users.albumsId',
          'in',
          eb
            .selectFrom('albums')
            .select(['id'])
            .where('ownerId', '=', userId)
            .union((eb) =>
              eb.parens(
                eb
                  .selectFrom('albums_shared_users_users as albumUsers')
                  .select(['albumUsers.albumsId as id'])
                  .where('albumUsers.usersId', '=', userId),
              ),
            ),
        ),
      )
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, DummyValue.UUID], stream: true })
  getAlbumAssetsBackfill(albumId: string, afterUpdateId: string | undefined, beforeUpdateId: string) {
    return this.db
      .selectFrom('assets')
      .innerJoin('albums_assets_assets as album_assets', 'album_assets.assetsId', 'assets.id')
      .select(columns.syncAsset)
      .select('assets.updateId')
      .where('album_assets.albumsId', '=', albumId)
      .where('assets.updatedAt', '<', sql.raw<Date>("now() - interval '1 millisecond'"))
      .where('assets.updateId', '<=', beforeUpdateId)
      .$if(!!afterUpdateId, (eb) => eb.where('assets.updateId', '>=', afterUpdateId!))
      .orderBy('assets.updateId', 'asc')
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID], stream: true })
  getAlbumAssetsUpserts(userId: string, ack?: SyncAck) {
    return this.db
      .selectFrom('assets')
      .innerJoin('albums_assets_assets as album_assets', 'album_assets.assetsId', 'assets.id')
      .select(columns.syncAsset)
      .select('assets.updateId')
      .where('assets.updatedAt', '<', sql.raw<Date>("now() - interval '1 millisecond'"))
      .$if(!!ack, (qb) => qb.where('assets.updateId', '>', ack!.updateId))
      .orderBy('assets.updateId', 'asc')
      .innerJoin('albums', 'albums.id', 'album_assets.albumsId')
      .leftJoin('albums_shared_users_users as album_users', 'album_users.albumsId', 'album_assets.albumsId')
      .where((eb) => eb.or([eb('albums.ownerId', '=', userId), eb('album_users.usersId', '=', userId)]))
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, DummyValue.UUID], stream: true })
  getAlbumToAssetBackfill(albumId: string, afterUpdateId: string | undefined, beforeUpdateId: string) {
    return this.db
      .selectFrom('albums_assets_assets as album_assets')
      .select(['album_assets.assetsId as assetId', 'album_assets.albumsId as albumId', 'album_assets.updateId'])
      .where('album_assets.albumsId', '=', albumId)
      .where('album_assets.updatedAt', '<', sql.raw<Date>("now() - interval '1 millisecond'"))
      .where('album_assets.updateId', '<=', beforeUpdateId)
      .$if(!!afterUpdateId, (eb) => eb.where('album_assets.updateId', '>=', afterUpdateId!))
      .orderBy('album_assets.updateId', 'asc')
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID], stream: true })
  getAlbumToAssetUpserts(userId: string, ack?: SyncAck) {
    return this.db
      .selectFrom('albums_assets_assets as album_assets')
      .select(['album_assets.assetsId as assetId', 'album_assets.albumsId as albumId', 'album_assets.updateId'])
      .where('album_assets.updatedAt', '<', sql.raw<Date>("now() - interval '1 millisecond'"))
      .$if(!!ack, (qb) => qb.where('album_assets.updateId', '>', ack!.updateId))
      .orderBy('album_assets.updateId', 'asc')
      .innerJoin('albums', 'albums.id', 'album_assets.albumsId')
      .leftJoin('albums_shared_users_users as album_users', 'album_users.albumsId', 'album_assets.albumsId')
      .where((eb) => eb.or([eb('albums.ownerId', '=', userId), eb('album_users.usersId', '=', userId)]))
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, DummyValue.UUID], stream: true })
  getAlbumAssetExifsBackfill(albumId: string, afterUpdateId: string | undefined, beforeUpdateId: string) {
    return this.db
      .selectFrom('exif')
      .innerJoin('albums_assets_assets as album_assets', 'album_assets.assetsId', 'exif.assetId')
      .select(columns.syncAssetExif)
      .select('exif.updateId')
      .where('album_assets.albumsId', '=', albumId)
      .where('exif.updatedAt', '<', sql.raw<Date>("now() - interval '1 millisecond'"))
      .where('exif.updateId', '<=', beforeUpdateId)
      .$if(!!afterUpdateId, (eb) => eb.where('exif.updateId', '>=', afterUpdateId!))
      .orderBy('exif.updateId', 'asc')
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID], stream: true })
  getAlbumAssetExifsUpserts(userId: string, ack?: SyncAck) {
    return this.db
      .selectFrom('exif')
      .innerJoin('albums_assets_assets as album_assets', 'album_assets.assetsId', 'exif.assetId')
      .select(columns.syncAssetExif)
      .select('exif.updateId')
      .where('exif.updatedAt', '<', sql.raw<Date>("now() - interval '1 millisecond'"))
      .$if(!!ack, (qb) => qb.where('exif.updateId', '>', ack!.updateId))
      .orderBy('exif.updateId', 'asc')
      .innerJoin('albums', 'albums.id', 'album_assets.albumsId')
      .leftJoin('albums_shared_users_users as album_users', 'album_users.albumsId', 'album_assets.albumsId')
      .where((eb) => eb.or([eb('albums.ownerId', '=', userId), eb('album_users.usersId', '=', userId)]))
      .stream();
  }

  private auditTableFilters<T extends keyof Pick<DB, AuditTables>, D>(qb: SelectQueryBuilder<DB, T, D>, ack?: SyncAck) {
    const builder = qb as SelectQueryBuilder<DB, AuditTables, D>;
    return builder
      .where('deletedAt', '<', sql.raw<Date>("now() - interval '1 millisecond'"))
      .$if(!!ack, (qb) => qb.where('id', '>', ack!.updateId))
      .orderBy('id', 'asc') as SelectQueryBuilder<DB, T, D>;
  }

  private upsertTableFilters<T extends keyof Pick<DB, UpsertTables>, D>(
    qb: SelectQueryBuilder<DB, T, D>,
    ack?: SyncAck,
  ) {
    const builder = qb as SelectQueryBuilder<DB, UpsertTables, D>;
    return builder
      .where('updatedAt', '<', sql.raw<Date>("now() - interval '1 millisecond'"))
      .$if(!!ack, (qb) => qb.where('updateId', '>', ack!.updateId))
      .orderBy('updateId', 'asc') as SelectQueryBuilder<DB, T, D>;
  }
}
