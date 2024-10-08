/* istanbul ignore file */
import {fs} from 'mz';

import * as Models from '../../../models';
import {BackupUtils} from '../../../utils';
import {logger} from '../../../utils/logger';
import {Driver} from '../driver';
import {EmberKeyType, EmberKeyStruct, EmberNetworkParameters, EmberSecurityManagerNetworkKeyInfo, EmberKeyData} from '../driver/types';
import {channelsMask2list} from '../driver/utils';

const NS = 'zh:ezsp:backup';

export class EZSPAdapterBackup {
    private driver: Driver;
    private defaultPath: string;

    public constructor(driver: Driver, path: string) {
        this.driver = driver;
        this.defaultPath = path;
    }

    public async createBackup(): Promise<Models.Backup> {
        logger.debug('creating backup', NS);
        const version: number = await this.driver.ezsp.version();
        const linkResult = await this.driver.getKey(EmberKeyType.TRUST_CENTER_LINK_KEY);
        const netParams = await this.driver.ezsp.execCommand('getNetworkParameters');
        const networkParams: EmberNetworkParameters = netParams.parameters;
        const netResult = await this.driver.getKey(EmberKeyType.CURRENT_NETWORK_KEY);
        let tclKey: Buffer = null;
        let netKey: Buffer = null;
        let netKeySequenceNumber: number = 0;
        let netKeyFrameCounter: number = 0;

        if (version < 13) {
            tclKey = Buffer.from((linkResult.keyStruct as EmberKeyStruct).key.contents);
            netKey = Buffer.from((netResult.keyStruct as EmberKeyStruct).key.contents);
            netKeySequenceNumber = (netResult.keyStruct as EmberKeyStruct).sequenceNumber;
            netKeyFrameCounter = (netResult.keyStruct as EmberKeyStruct).outgoingFrameCounter;
        } else {
            tclKey = Buffer.from((linkResult.keyData as EmberKeyData).contents);
            netKey = Buffer.from((netResult.keyData as EmberKeyData).contents);
            // get rest of info from second cmd in EZSP 13+
            const netKeyInfoResult = await this.driver.getNetworkKeyInfo();
            const networkKeyInfo: EmberSecurityManagerNetworkKeyInfo = netKeyInfoResult.networkKeyInfo;
            netKeySequenceNumber = networkKeyInfo.networkKeySequenceNumber;
            netKeyFrameCounter = networkKeyInfo.networkKeyFrameCounter;
        }

        const ieee = (await this.driver.ezsp.execCommand('getEui64')).eui64;
        /* return backup structure */
        /* istanbul ignore next */
        return {
            ezsp: {
                version: version,
                hashed_tclk: tclKey,
            },
            networkOptions: {
                panId: networkParams.panId,
                extendedPanId: Buffer.from(networkParams.extendedPanId),
                channelList: channelsMask2list(networkParams.channels),
                networkKey: netKey,
                networkKeyDistribute: true,
            },
            logicalChannel: networkParams.radioChannel,
            networkKeyInfo: {
                sequenceNumber: netKeySequenceNumber,
                frameCounter: netKeyFrameCounter,
            },
            securityLevel: 5,
            networkUpdateId: networkParams.nwkUpdateId,
            coordinatorIeeeAddress: ieee,
            devices: [],
        };
    }

    /**
     * Loads currently stored backup and returns it in internal backup model.
     */
    public async getStoredBackup(): Promise<Models.Backup> {
        try {
            await fs.access(this.defaultPath);
        } catch {
            return null;
        }
        let data;
        try {
            data = JSON.parse((await fs.readFile(this.defaultPath)).toString());
        } catch (error) {
            throw new Error(`Coordinator backup is corrupted (${error.message})`);
        }
        if (data.metadata?.format === 'zigpy/open-coordinator-backup' && data.metadata?.version) {
            if (data.metadata?.version !== 1) {
                throw new Error(`Unsupported open coordinator backup version (version=${data.metadata?.version})`);
            }
            if (!data.metadata.internal?.ezspVersion) {
                throw new Error(`This open coordinator backup format not for EZSP adapter`);
            }
            return BackupUtils.fromUnifiedBackup(data);
        } else {
            throw new Error('Unknown backup format');
        }
    }
}
