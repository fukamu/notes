package telemetry

type SinkResult string

const (
	SinkBuffered SinkResult = "buffered"
	SinkDropped  SinkResult = "dropped"
)

// Sink is a synchronous buffer boundary. Provider I/O belongs in an adapter
// which drains that buffer outside the request correctness path.
type Sink interface {
	Record(Event) SinkResult
}

type DeliveryKind string

const (
	DeliveryRecorded DeliveryKind = "recorded"
	DeliveryDropped  DeliveryKind = "dropped"
)

type DropReason string

const (
	DropInvalidEvent DropReason = "invalid-event"
	DropSinkRejected DropReason = "sink-rejected"
	DropSinkFailure  DropReason = "sink-failure"
)

type Delivery struct {
	kind   DeliveryKind
	reason DropReason
}

func (delivery Delivery) Kind() DeliveryKind { return delivery.kind }
func (delivery Delivery) Reason() DropReason { return delivery.reason }

func RecordSafely(sink Sink, plan EventPlan) (delivery Delivery) {
	delivery = Delivery{kind: DeliveryDropped, reason: DropSinkFailure}
	accepted, ok := plan.(AcceptedEvent)
	if !ok || !validEvent(accepted.event) {
		return Delivery{kind: DeliveryDropped, reason: DropInvalidEvent}
	}
	if sink == nil {
		return delivery
	}
	defer func() {
		if recover() != nil {
			delivery = Delivery{kind: DeliveryDropped, reason: DropSinkFailure}
		}
	}()
	switch sink.Record(accepted.event) {
	case SinkBuffered:
		return Delivery{kind: DeliveryRecorded}
	case SinkDropped:
		return Delivery{kind: DeliveryDropped, reason: DropSinkRejected}
	default:
		return Delivery{kind: DeliveryDropped, reason: DropSinkFailure}
	}
}

type noOpSink struct{}

func (noOpSink) Record(Event) SinkResult { return SinkBuffered }

func NoOpSink() Sink { return noOpSink{} }
