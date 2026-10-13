// The consumer side of the contract, for the app: the reader `app` of the directory.
//
// The app sends its requests with dio. These tests give it a dio whose adapter answers with
// a fixture and keeps the request (package:contract_fixtures_dio), so the client's own code
// builds the request and dio decodes the response, as in the app.
//
// - provider fixtures: the responses the API really gave (../contracts/provider/, verified
//   by the provider's tests) reach the client's real response handling. Where the API
//   returned a secret, the fixture holds a placeholder.
// - consumer fixtures: the requests the client really sends are verified against
//   ../contracts/consumer/app.* (the provider's tests pass those to the real handler).
// - tables: run the shared rows through this side's calculation.
import 'package:contract_fixtures/contract_fixtures.dart';
import 'package:contract_fixtures_dio/contract_fixtures_dio.dart';
import 'package:contract_fixtures_example_consumer/orders_client.dart';
import 'package:dio/dio.dart';
import 'package:test/test.dart';

final contract = ContractFixtures(
  side: ContractSide.consumer,
  reader: 'app',
  dir: '../contracts',
);

/// A client whose dio answers with [response]; the adapter collects what it sends.
({OrdersClient client, FixtureAdapter adapter}) clientAnsweredBy(
  ExchangeResponse response,
) {
  final adapter = FixtureAdapter(response);
  final dio = Dio(BaseOptions(baseUrl: 'https://orders.example.test'))
    ..httpClientAdapter = adapter;
  return (
    client: OrdersClient(dio, authorization: '<token:customer-1>'),
    adapter: adapter,
  );
}

/// What the app does, as a string, so the expectations below read as a table.
Future<String> outcome(String name) async {
  final (:client, :adapter) =
      clientAnsweredBy(contract.readResponse(name).response);
  final result = await client.placeOrder(sku: 'tea-100', quantity: 2);
  expect(adapter.sent, hasLength(1));
  return switch (result) {
    OrderPlaced(:final totalMinor) => 'placed, total $totalMinor',
    OutOfStock(:final available) => 'out of stock, $available left',
    CouponRejected() => 'coupon rejected',
    SignInAgain() => 'sign in again',
    OrderFailed() => 'failed',
  };
}

/// Fixture name -> what the app must do when it receives that response.
const expectations = <String, String>{
  'order.created': 'placed, total 1200',
  'order.created-with-coupon': 'placed, total 899',
  'order.out-of-stock': 'out of stock, 0 left',
  'order.coupon-unknown': 'coupon rejected',
  'order.invalid-quantity': 'failed',
  'order.token-invalid': 'sign in again',
};

/// The same for the responses to "start the payment". The fixture holds a placeholder where
/// the API returned a secret; this side puts a value of its own in before the client reads it.
const paymentExpectations = <String, String>{
  'payment.started': 'confirm with the key of payment-1',
};

/// The same for the receipt, where the response headers are a part of the agreement.
const receiptExpectations = <String, String>{
  'receipt.downloaded': 'save receipt-<order id>.json, total 1200',
};

void main() {
  // Each table above covers the fixtures of one prefix. This test shows that the prefixes
  // leave no provider fixture out: one that starts with something else fails here.
  test('every provider fixture belongs to one of the tables', () {
    contract.assertPrefixesCover(
      FixtureKind.provider,
      ['order.', 'payment.', 'receipt.'],
    );
  });

  group('provider fixtures: a response whose headers matter', () {
    test('every receipt fixture has an expectation here', () {
      contract.assertCovers(
        FixtureKind.provider,
        receiptExpectations.keys,
        prefix: 'receipt.',
      );
    });

    for (final entry in receiptExpectations.entries) {
      test(entry.key, () async {
        final response = contract.readResponse(entry.key).response;

        final result =
            await clientAnsweredBy(response).client.loadReceipt('ord_demo1');

        // The id is the one of the order the provider's test happened to place.
        final orderId = (response.body as Map<String, dynamic>)['order_id'];
        expect(
          switch (result) {
            ReceiptReady(:final fileName, :final totalMinor) =>
              'save ${fileName.replaceFirst('$orderId', '<order id>')}, '
                  'total $totalMinor',
            ReceiptFailed() => 'failed',
          },
          entry.value,
        );
      });
    }
  });

  group('provider fixtures: a response with a secret in it', () {
    test('every payment fixture has an expectation here', () {
      contract.assertCovers(
        FixtureKind.provider,
        paymentExpectations.keys,
        prefix: 'payment.',
      );
    });

    for (final entry in paymentExpectations.entries) {
      test(entry.key, () async {
        final response = contract.readResponse(entry.key).response;
        final body = resolvePlaceholders(
          response.body,
          (kind, name) => kind == 'key' ? 'the key of $name' : null,
        );

        final result = await clientAnsweredBy(
          ExchangeResponse(
            status: response.status,
            headers: response.headers,
            body: body,
          ),
        ).client.startPayment('ord_demo1');

        expect(
          switch (result) {
            PaymentStarted(:final confirmKey) => 'confirm with $confirmKey',
            PaymentFailed() => 'failed',
          },
          entry.value,
        );
      });
    }
  });

  group('provider fixtures: what the app makes of real responses', () {
    test('every provider fixture has an expectation here', () {
      contract.assertCovers(
        FixtureKind.provider,
        expectations.keys,
        prefix: 'order.',
      );
    });

    for (final entry in expectations.entries) {
      test(entry.key, () async {
        expect(await outcome(entry.key), entry.value);
      });
    }

    test('order.created: the id of a real response can be read', () async {
      final response = contract.readResponse('order.created').response;
      final result = await clientAnsweredBy(response)
          .client
          .placeOrder(sku: 'tea-100', quantity: 2);
      expect((result as OrderPlaced).id, startsWith('ord_'));
    });
  });

  group('consumer fixtures: the requests the client really builds', () {
    /// Sends one request to a client answered by `order.created`, and verifies what dio
    /// was given: the headers that are part of the agreement, not the ones dio adds.
    Future<void> verify(
      String name,
      String description,
      Future<void> Function(OrdersClient client) send,
    ) async {
      final (:client, :adapter) =
          clientAnsweredBy(contract.readResponse('order.created').response);
      await send(client);
      contract.verifyRequest(
        name: name,
        description: description,
        request: exchangeRequestFromDio(
          adapter.sent.single,
          headers: ['authorization', 'content-type'],
        ),
      );
    }

    test('app.create-order.request', () async {
      await verify(
        'app.create-order.request',
        'The request the client sends to place an order',
        (client) => client.placeOrder(sku: 'tea-100', quantity: 2),
      );
    });

    test('app.create-order.with-coupon.request', () async {
      await verify(
        'app.create-order.with-coupon.request',
        'The request the client sends to place an order with a coupon',
        (client) =>
            client.placeOrder(sku: 'tin-300', quantity: 1, coupon: 'SAVE10'),
      );
    });
  });

  group('table: order-total', () {
    for (final row in contract.readTable('order-total').rows) {
      test(row['case'], () {
        expect(
          orderTotalMinor(
            unitPriceMinor: row['unit_price_minor'] as int,
            quantity: row['quantity'] as int,
            discountPercent: row['discount_percent'] as int,
          ),
          row['expected_minor'],
        );
      });
    }
  });
}
