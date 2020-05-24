import { EventDispatcher } from './EventDispatcher';
import { SignalingEvent, SignalingEventType } from './Signaling';
import { EventHandler } from './EventHandler';
import { Room } from './Room';

export class Participant {
    private id: string;
    private room: Room;
    private peer: RTCPeerConnection;
    private channel?: RTCDataChannel;
    private dispatcher: EventDispatcher = new EventDispatcher();
    private offerAnswerOptions: RTCOfferOptions;

    constructor(id: string, room: Room) {
        this.id = id;
        this.room = room;
        this.offerAnswerOptions = {
            offerToReceiveAudio: true,
            offerToReceiveVideo: true,
        };

        this.peer = new RTCPeerConnection(this.room.getConfiguration().getServers());

        const stream = this.room.getStream();
        if (stream instanceof MediaStream) {
            this.addStream(stream);
        }

        this.peer.onicecandidate = this.onIceCandidate;
        this.peer.onconnectionstatechange = this.onConnectionStateChange;
        this.peer.oniceconnectionstatechange = this.onIceConnectionStateChange;
        this.peer.onnegotiationneeded = this.onNegotiationNeeded;
        this.peer.ondatachannel = this.onDataChannel;
        this.peer.ontrack = this.dispatchRemoteStream;
    }

    getId = (): string => this.id;

    on = (event: string, callback: EventHandler): Participant => {
        this.dispatcher.register(event, callback);

        return this;
    };

    send = (payload: any): Participant => {
        if (!this.channel || this.channel.readyState !== 'open') {
            return this;
        }

        this.channel.send(payload);

        return this;
    };

    close = (): Participant => {
        if (this.channel) {
            this.channel.close();
        }

        this.peer.close();
        this.dispatcher.dispatch('disconnected');

        return this;
    };

    addStream = (stream: MediaStream): Participant => {
        stream.getTracks().map(track => this.peer.addTrack(track, stream));

        return this;
    };

    onSignalingEvent = (event: SignalingEvent): Participant => {
        if (!event.caller || this.id !== event.caller.id) {
            return this;
        }

        switch (event.type) {
        case SignalingEventType.ANSWER:
            this.onAnswer(event);
            break;
        case SignalingEventType.CANDIDATE:
            this.onCandidate(event);
            break;
        }

        return this;
    };

    renegotiate = async (remoteDesc?: RTCSessionDescription): Promise<Participant> => {
        const promises: Promise<any>[] = [];

        if (remoteDesc) {
            if (remoteDesc.type === 'offer' && this.peer.signalingState !== 'stable') {
                promises.push(this.peer.setLocalDescription({type: 'rollback'}));
            }

            promises.push(this.peer.setRemoteDescription(remoteDesc));

            if (remoteDesc.type === 'offer') {
                promises.push(this.peer
                    .createAnswer(this.offerAnswerOptions)
                    .then((desc: RTCSessionDescriptionInit): Promise<void> => this.peer.setLocalDescription(desc))
                    .then((): void => this.room.getEventDispatcher().dispatch('send', {
                        type: SignalingEventType.ANSWER,
                        caller: { id: this.room.getParticipantId() },
                        callee: { id: this.id },
                        room: { id: this.room.getId() },
                        payload: this.peer.localDescription,
                    } as SignalingEvent))
                );
            }
        } else {
            this.channel = this.newDataChannel(this.room.getConfiguration().getDataConstraints());
            this.channel.onmessage = this.onMessage;

            promises.push(this.peer
                .createOffer(this.offerAnswerOptions)
                .then((desc: RTCSessionDescriptionInit): Promise<void> => {
                    // prevent race condition if another side send us offer at the time
                    // when we were in process of createOffer
                    if (this.peer.signalingState === 'stable') {
                        return this.peer
                            .setLocalDescription(desc)
                            .then((): void => this.room.getEventDispatcher().dispatch('send', {
                                type: SignalingEventType.OFFER,
                                caller: { id: this.room.getParticipantId() },
                                callee: { id: this.id },
                                room: { id: this.room.getId() },
                                payload: this.peer.localDescription,
                            } as SignalingEvent));
                    }

                    return Promise.resolve();
                })
            );
        }

        return Promise
            .all(promises)
            .then((): Participant => this);
    };

    private newDataChannel = (dataConstraints?: RTCDataChannelInit): RTCDataChannel => {
        const label = Math.floor((1 + Math.random()) * 1e16)
            .toString(16)
            .substring(1);

        return this.peer.createDataChannel(label, dataConstraints);
    };

    private onAnswer = (event: SignalingEvent): void => {
        this
            .renegotiate(new RTCSessionDescription(event.payload))
            .catch((evnt: DOMException): void => this.dispatcher.dispatch('error', evnt));
    };

    private onCandidate = (event: SignalingEvent): void => {
        this.peer
            .addIceCandidate(new RTCIceCandidate(event.payload))
            .catch((evnt: DOMException): void => this.dispatcher.dispatch('error', evnt));
    };

    private onIceCandidate = (iceEvent: RTCPeerConnectionIceEvent): void => {
        if (iceEvent.candidate) {
            this.room.getEventDispatcher().dispatch('send', {
                type: SignalingEventType.CANDIDATE,
                caller: { id: this.room.getParticipantId() },
                callee: { id: this.id },
                room: { id: this.room.getId() },
                payload: iceEvent.candidate,
            } as SignalingEvent);
        } else {
            // All ICE candidates have been sent
        }
    };

    private onConnectionStateChange = (): void => {
        switch (this.peer.connectionState) {
        case 'connected':
        // The connection has become fully connected
            break;
        case 'disconnected':
        case 'failed':
            // One or more transports has terminated unexpectedly or in an error
        case 'closed':
            this.dispatcher.dispatch('disconnected');
            // The connection has been closed
            break;
        }
    };

    private onIceConnectionStateChange = (): void => {
        switch (this.peer.iceConnectionState) {
        case 'disconnected':
        case 'failed':
        case 'closed':
            this.dispatcher.dispatch('disconnected');
            break;
        }
    };

    private onNegotiationNeeded = (): void => {
        this
            .renegotiate()
            .catch((evnt: DOMException): void => this.dispatcher.dispatch('error', evnt));
    };

    private onDataChannel = (event: RTCDataChannelEvent): void => {
        this.channel = event.channel;
        this.channel.onmessage = this.onMessage;
    };

    private onMessage = (event: MessageEvent): void => {
        this.dispatcher.dispatch('message', event.data);
    };

    private dispatchRemoteStream = (event: RTCTrackEvent): void => {
        this.dispatcher.dispatch('track', event);
    };
}
